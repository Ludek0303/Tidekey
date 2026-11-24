//! Where the encrypted file bodies live (PLIKI.md §4): one object per file under the key `<vault>/<id>`. The
//! database stays the source of truth for state; a store only holds ciphertext and answers for its size.
//!
//! `LocalStore` keeps objects in `<data>/attachments`. `SeaweedStore` talks to a SeaweedFS filer over HTTP, with
//! an optional HS256 token that the filer checks (`NOTES_SEAWEEDFS_JWT_KEY`).

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{HeaderValue, Method, Request, Response, StatusCode, header::{ACCEPT, AUTHORIZATION, CONTENT_LENGTH}};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{KeyInit, Mac};
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::TokioExecutor;
use serde_json::{Value, json};
use tokio_util::io::ReaderStream;

/// Directory (under the attachments root) where objects that no record refers to are moved.
pub const ORPHAN_DIR: &str = ".orphans";
/// Filer folder of all objects, `/notes-files/<vault>/<id>`.
const FILER_ROOT: &str = "/notes-files";
const FILER_PAGE: usize = 1000;
/// Lifetime of the filer token; a fresh one is made for every request.
const TOKEN_TTL_SECS: u64 = 60;
/// Bit of the filer's `Mode` field that marks a folder (Go's `os.ModeDir`).
const MODE_DIR: u64 = 1 << 31;

/// Storage of encrypted objects. Keys are `<vault>/<id>`; the caller checks that both parts are safe names.
#[async_trait]
pub trait ObjectStore: Send + Sync {
    /// Stores the file at `src` as the object `key`, replacing an object already there. `src` is left in place.
    async fn put(&self, key: &str, src: &Path) -> io::Result<()>;
    /// The object's bytes, streamed. `NotFound` when there is no object.
    async fn get(&self, key: &str) -> io::Result<Body>;
    /// The object's size in bytes. `NotFound` when there is no object; other errors mean the store is unreachable.
    async fn size(&self, key: &str) -> io::Result<u64>;
    /// Removes the object. A missing object is not an error.
    async fn delete(&self, key: &str) -> io::Result<()>;
    /// Keys `<vault>/<id>` of the objects in one vault, with their sizes.
    async fn list(&self, vault: &str) -> io::Result<Vec<(String, u64)>>;
    /// Names of the vaults that have a folder in the store.
    async fn vaults(&self) -> io::Result<Vec<String>>;
    /// Sets aside an object that no record refers to. It is never deleted: the store may keep it as it is.
    async fn orphan(&self, key: &str) -> io::Result<()>;
}

pub const LOCAL: &str = "local";
pub const SEAWEEDFS: &str = "seaweedfs";
/// `<data>/storage.json`: which store is current, once the admin panel has switched it (PANEL-ADMINA.md).
pub const STORAGE_FILE: &str = "storage.json";

/// The stores this node can use and the one in use. Both are open when SeaweedFS is configured, so the admin
/// panel can move the files from one to the other.
pub struct Backends {
    pub current: &'static str,
    pub stores: Vec<(&'static str, Arc<dyn ObjectStore>)>,
}

/// Opens the local store, SeaweedFS when the environment names a filer, and picks the current one (never a secret
/// in the log). `data` is the node's data folder; local objects live in `<data>/attachments`.
pub fn open_backends(data: &Path) -> io::Result<Backends> {
    let local: Arc<dyn ObjectStore> = Arc::new(LocalStore::open(&data.join("attachments"))?);
    let filer = std::env::var("NOTES_SEAWEEDFS_FILER").unwrap_or_default();
    let seaweed: Option<Arc<dyn ObjectStore>> = if filer.is_empty() {
        None
    } else {
        let key = std::env::var("NOTES_SEAWEEDFS_JWT_KEY").ok().filter(|k| !k.is_empty());
        if key.is_some() {
            eprintln!("notes-node files: SeaweedFS z JWT");
        }
        Some(Arc::new(SeaweedStore::new(&filer, key.map(String::into_bytes))?))
    };
    let backends = backends(data, local, seaweed)?;
    eprintln!("notes-node files: magazyn {}", if backends.current == LOCAL { "lokalny" } else { "SeaweedFS" });
    Ok(backends)
}

/// The current store: `storage.json` when it exists, else SeaweedFS when it is configured, else local.
pub fn backends(data: &Path, local: Arc<dyn ObjectStore>, seaweed: Option<Arc<dyn ObjectStore>>) -> io::Result<Backends> {
    let saved = match std::fs::read(data.join(STORAGE_FILE)) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| io::Error::other("storage.json jest uszkodzony"))?;
            Some(value["backend"].as_str().unwrap_or_default().to_string())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let current = match saved.as_deref() {
        None if seaweed.is_some() => SEAWEEDFS,
        None | Some(LOCAL) => LOCAL,
        Some(SEAWEEDFS) if seaweed.is_some() => SEAWEEDFS,
        // refusing to start beats serving every file as missing
        Some(SEAWEEDFS) => return Err(io::Error::other("storage.json wskazuje SeaweedFS, ale NOTES_SEAWEEDFS_FILER nie jest ustawiony")),
        Some(_) => return Err(io::Error::other("storage.json: nieznany magazyn")),
    };
    let mut stores = vec![(LOCAL, local)];
    stores.extend(seaweed.map(|s| (SEAWEEDFS, s)));
    Ok(Backends { current, stores })
}

/// Records `backend` as current: temp file, fsync, rename, fsync of the folder.
pub fn save_backend(data: &Path, backend: &str) -> io::Result<()> {
    notes_core::write_atomic(&data.join(STORAGE_FILE), json!({ "backend": backend }).to_string().as_bytes())
}

/// The current store, swappable while the node runs. Each call holds the read side for its own duration; `switch`
/// takes the write side, so it waits for calls in flight. Callers that need several calls on one store hold
/// `current()` across them.
pub struct SwitchableStore(tokio::sync::RwLock<Arc<dyn ObjectStore>>);

impl SwitchableStore {
    pub fn new(store: Arc<dyn ObjectStore>) -> Self {
        Self(tokio::sync::RwLock::new(store))
    }

    pub async fn current(&self) -> tokio::sync::RwLockReadGuard<'_, Arc<dyn ObjectStore>> {
        self.0.read().await
    }

    /// The write side: no call runs on the store while it is held, and assigning through it switches the store.
    pub async fn switch(&self) -> tokio::sync::RwLockWriteGuard<'_, Arc<dyn ObjectStore>> {
        self.0.write().await
    }
}

#[async_trait]
impl ObjectStore for SwitchableStore {
    async fn put(&self, key: &str, src: &Path) -> io::Result<()> { self.current().await.put(key, src).await }
    async fn get(&self, key: &str) -> io::Result<Body> { self.current().await.get(key).await }
    async fn size(&self, key: &str) -> io::Result<u64> { self.current().await.size(key).await }
    async fn delete(&self, key: &str) -> io::Result<()> { self.current().await.delete(key).await }
    async fn list(&self, vault: &str) -> io::Result<Vec<(String, u64)>> { self.current().await.list(vault).await }
    async fn vaults(&self) -> io::Result<Vec<String>> { self.current().await.vaults().await }
    async fn orphan(&self, key: &str) -> io::Result<()> { self.current().await.orphan(key).await }
}

fn now_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

/// Objects as plain files: `<root>/<vault>/<id>`.
pub struct LocalStore {
    root: PathBuf,
}

impl LocalStore {
    pub fn open(root: &Path) -> io::Result<Self> {
        std::fs::create_dir_all(root.join(ORPHAN_DIR))?;
        Ok(Self { root: root.to_path_buf() })
    }

    fn path(&self, key: &str) -> PathBuf {
        self.root.join(key)
    }
}

#[async_trait]
impl ObjectStore for LocalStore {
    async fn put(&self, key: &str, src: &Path) -> io::Result<()> {
        let dst = self.path(key);
        if let Some(dir) = dst.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        // A hard link costs no copy; the part and the object share the bytes until the caller drops the part.
        let _ = tokio::fs::remove_file(&dst).await;
        if tokio::fs::hard_link(src, &dst).await.is_err() {
            tokio::fs::copy(src, &dst).await?;
        }
        if let Some(dir) = dst.parent() {
            tokio::fs::File::open(dir).await?.sync_all().await?;
        }
        Ok(())
    }

    async fn get(&self, key: &str) -> io::Result<Body> {
        let file = tokio::fs::File::open(self.path(key)).await?;
        Ok(Body::from_stream(ReaderStream::new(file)))
    }

    async fn size(&self, key: &str) -> io::Result<u64> {
        Ok(tokio::fs::metadata(self.path(key)).await?.len())
    }

    async fn delete(&self, key: &str) -> io::Result<()> {
        match tokio::fs::remove_file(self.path(key)).await {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    async fn list(&self, vault: &str) -> io::Result<Vec<(String, u64)>> {
        let mut keys = Vec::new();
        let mut entries = match tokio::fs::read_dir(self.root.join(vault)).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(keys),
            Err(e) => return Err(e),
        };
        while let Some(entry) = entries.next_entry().await? {
            if entry.file_type().await?.is_file() {
                keys.push((format!("{vault}/{}", entry.file_name().to_string_lossy()), entry.metadata().await?.len()));
            }
        }
        Ok(keys)
    }

    async fn vaults(&self) -> io::Result<Vec<String>> {
        let mut names = Vec::new();
        let mut entries = tokio::fs::read_dir(&self.root).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with('.') && entry.file_type().await?.is_dir() {
                names.push(name);
            }
        }
        Ok(names)
    }

    async fn orphan(&self, key: &str) -> io::Result<()> {
        let name = format!("{}-{}", key.replace('/', "-"), now_millis());
        tokio::fs::rename(self.path(key), self.root.join(ORPHAN_DIR).join(name)).await
    }
}

type Http = Client<HttpConnector, Body>;

/// Objects in a SeaweedFS filer (`/notes-files/<vault>/<id>`), reached over the filer's HTTP API.
pub struct SeaweedStore {
    /// `http://host:port`, no trailing slash.
    filer: String,
    client: Http,
    jwt_key: Option<Vec<u8>>,
}

impl SeaweedStore {
    pub fn new(filer: &str, jwt_key: Option<Vec<u8>>) -> io::Result<Self> {
        let filer = filer.trim_end_matches('/').to_string();
        if !filer.starts_with("http://") {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "NOTES_SEAWEEDFS_FILER musi zaczynać się od http://"));
        }
        let client = Client::builder(TokioExecutor::new()).build_http();
        Ok(Self { filer, client, jwt_key })
    }

    /// One request. Errors never carry the URL, so keys stay out of the log.
    async fn send(&self, method: Method, path: &str, body: Body, extra: Option<(&str, HeaderValue)>) -> io::Result<Response<Body>> {
        let mut builder = Request::builder().method(method).uri(format!("{}{path}", self.filer));
        if let Some(key) = &self.jwt_key {
            builder = builder.header(AUTHORIZATION, format!("Bearer {}", token(key)));
        }
        if let Some((name, value)) = extra {
            builder = builder.header(name, value);
        }
        let request = builder.body(body).map_err(|_| io::Error::other("zły adres SeaweedFS"))?;
        let response = self
            .client
            .request(request)
            .await
            .map_err(|_| io::Error::other("SeaweedFS jest niedostępny"))?;
        let (parts, body) = response.into_parts();
        Ok(Response::from_parts(parts, Body::new(body)))
    }

    /// Passes 2xx on; 404 becomes `NotFound`, any other status an error with the code only.
    fn check(response: Response<Body>) -> io::Result<Response<Body>> {
        let status = response.status();
        if status.is_success() {
            Ok(response)
        } else if status == StatusCode::NOT_FOUND {
            Err(io::Error::new(io::ErrorKind::NotFound, "brak obiektu"))
        } else {
            Err(io::Error::other(format!("SeaweedFS odpowiedział HTTP {}", status.as_u16())))
        }
    }

    /// Names of the entries in a filer folder, with whether each is a folder and its size. Pages through the listing.
    async fn entries(&self, dir: &str) -> io::Result<Vec<(String, bool, u64)>> {
        let mut out = Vec::new();
        let mut last = String::new();
        loop {
            // names are our own hex ids, but the query is encoded anyway
            let query = if last.is_empty() { String::new() } else { format!("&lastFileName={}", encode_query(&last)) };
            let path = format!("{dir}/?limit={FILER_PAGE}{query}");
            // a folder that does not exist yet (nothing stored) lists as empty
            let sent = self.send(Method::GET, &path, Body::empty(), Some((ACCEPT.as_str(), HeaderValue::from_static("application/json")))).await;
            let response = match sent.and_then(Self::check) {
                Ok(response) => response,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
                Err(e) => return Err(e),
            };
            let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
                .await
                .map_err(|_| io::Error::other("zła odpowiedź SeaweedFS"))?;
            let listing: Value = serde_json::from_slice(&bytes).map_err(|_| io::Error::other("zła odpowiedź SeaweedFS"))?;
            let entries = listing["Entries"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            for entry in entries {
                let full = entry["FullPath"].as_str().unwrap_or_default();
                let name = full.rsplit('/').next().unwrap_or_default().to_string();
                let is_dir = entry["Mode"].as_u64().is_some_and(|m| m & MODE_DIR != 0);
                out.push((name.clone(), is_dir, entry["FileSize"].as_u64().unwrap_or(0)));
                last = name;
            }
            if entries.len() < FILER_PAGE {
                return Ok(out);
            }
        }
    }
}

fn encode_query(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// HS256 token with `exp` = now + 60 s, the claim SeaweedFS checks.
fn token(key: &[u8]) -> String {
    let exp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) + TOKEN_TTL_SECS;
    let head = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let claims = URL_SAFE_NO_PAD.encode(json!({ "exp": exp }).to_string());
    let signing = format!("{head}.{claims}");
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(signing.as_bytes());
    format!("{signing}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn object_path(key: &str) -> String {
    format!("{FILER_ROOT}/{key}")
}

#[async_trait]
impl ObjectStore for SeaweedStore {
    async fn put(&self, key: &str, src: &Path) -> io::Result<()> {
        let file = tokio::fs::File::open(src).await?;
        let len = file.metadata().await?.len();
        let body = Body::from_stream(ReaderStream::new(file));
        let response = self
            .send(Method::PUT, &object_path(key), body, Some((CONTENT_LENGTH.as_str(), HeaderValue::from(len))))
            .await?;
        Self::check(response).map(drop)
    }

    async fn get(&self, key: &str) -> io::Result<Body> {
        Ok(Self::check(self.send(Method::GET, &object_path(key), Body::empty(), None).await?)?.into_body())
    }

    async fn size(&self, key: &str) -> io::Result<u64> {
        let response = Self::check(self.send(Method::HEAD, &object_path(key), Body::empty(), None).await?)?;
        response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| io::Error::other("SeaweedFS nie podał długości"))
    }

    async fn delete(&self, key: &str) -> io::Result<()> {
        match Self::check(self.send(Method::DELETE, &object_path(key), Body::empty(), None).await?) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other.map(drop),
        }
    }

    async fn list(&self, vault: &str) -> io::Result<Vec<(String, u64)>> {
        let files = self.entries(&format!("{FILER_ROOT}/{vault}")).await?;
        Ok(files.into_iter().filter(|(_, dir, _)| !dir).map(|(name, _, size)| (format!("{vault}/{name}"), size)).collect())
    }

    async fn vaults(&self) -> io::Result<Vec<String>> {
        let dirs = self.entries(FILER_ROOT).await?;
        Ok(dirs.into_iter().filter(|(_, dir, _)| *dir).map(|(name, _, _)| name).collect())
    }

    /// Nothing to move in a filer: the object stays where it is, and the reconciliation log counts it.
    async fn orphan(&self, _key: &str) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
#[path = "objstore_tests.rs"]
mod tests;
