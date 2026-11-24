//! HTTP side of the node: `/health`, and the web app from `--web` (with `index.html` as the fallback
//! for client-side routes).

use std::net::{IpAddr, SocketAddr};
use std::path::Path;

use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Request};
use axum::http::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::{any, get};
use tower_http::services::{ServeDir, ServeFile};

/// Builds the HTTP application and merges same-origin API routes (authentication and browser sync).
/// API routes are mounted before the static fallback so `/api/*` is never answered by `index.html`.
pub fn app(web: Option<&Path>, models: Option<&Path>) -> Router {
    app_with_api(web, models, Router::new())
}

// The app's keys live in the page, so a script injected into it could use them: only the app's own scripts and WASM
// run, nothing loads from elsewhere (remote images in notes neither: no read receipts), and no site can frame it. The
// one other address the page talks to is the GitHub API (docs/GITHUB.md §6): public repositories need no server.
// `blob:` lets the speech model load from the browser's own storage (docs/DYKTOWANIE.md §5); it reaches no host.
const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
    img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: https://api.github.com; worker-src 'self' blob:; object-src 'none'; \
    base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const HSTS: &str = "max-age=31536000; includeSubDomains";

/// The security headers every response carries. HSTS only over HTTPS, where it can't lock out local HTTP use.
async fn security_headers(mut response: Response) -> Response {
    let h = response.headers_mut();
    for (name, value) in [
        ("content-security-policy", CSP),
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        // dictation records in the page itself (docs/DYKTOWANIE.md §2); frames from elsewhere still get no microphone
        ("permissions-policy", "camera=(), microphone=(self), geolocation=(), payment=(), usb=()"),
        // with COOP this makes the page cross-origin isolated, which the speech model's threaded WASM needs (§7)
        ("cross-origin-opener-policy", "same-origin"),
        ("cross-origin-embedder-policy", "require-corp"),
    ] {
        // a response with its own policy keeps it (a file download is sandboxed harder than the app)
        if !h.contains_key(name) {
            h.insert(name, HeaderValue::from_static(value));
        }
    }
    if crate::auth::https_deployment() {
        h.insert("strict-transport-security", HeaderValue::from_static(HSTS));
    }
    response
}

/// The headers a proxy adds. They are believed only from a trusted peer (see `settle_forwarded`).
const FORWARDED: [&str; 4] = ["cf-connecting-ip", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"];

/// A peer the node believes about forwarded headers: loopback, private, link-local or unique-local. That covers the
/// TLS proxy on the host (Caddy, cloudflared) and the Docker bridge; a public address is never a proxy here.
pub(crate) fn trusted_peer(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => trusted_peer(IpAddr::V4(v4)),
            None => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
        },
    }
}

/// Makes the forwarded headers honest before any handler reads them. From a public peer they are dropped, and
/// `X-Forwarded-For` is set to the peer itself, so a forged header cannot pick a rate-limit bucket or an origin.
/// From a trusted proxy with no `CF-Connecting-IP`, the client is the rightmost `X-Forwarded-For` hop that is not
/// itself a proxy: the leftmost hops are whatever the client sent.
fn settle_forwarded(headers: &mut HeaderMap, peer: Option<IpAddr>) {
    if !peer.is_some_and(trusted_peer) {
        for name in FORWARDED { headers.remove(name); }
        if let Some(ip) = peer
            && let Ok(value) = HeaderValue::from_str(&ip.to_string())
        {
            headers.insert("x-forwarded-for", value);
        }
        return;
    }
    if headers.contains_key("cf-connecting-ip") { return; }
    let client = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
        .and_then(|list| list.rsplit(',').map(str::trim)
            .find(|hop| !hop.is_empty() && !hop.parse::<IpAddr>().is_ok_and(trusted_peer)))
        .map(str::to_string)
        .or_else(|| peer.map(|ip| ip.to_string()));
    match client.and_then(|c| HeaderValue::from_str(&c).ok()) {
        Some(value) => { headers.insert("x-forwarded-for", value); }
        None => { headers.remove("x-forwarded-for"); }
    }
}

/// The TCP peer comes from `ConnectInfo`, set by `run.rs`; without it (tests) the peer counts as untrusted.
async fn trust_forwarded(mut request: Request, next: Next) -> Response {
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>().map(|ConnectInfo(addr)| addr.ip());
    settle_forwarded(request.headers_mut(), peer);
    next.run(request).await
}

/// axum's own JSON and path rejections answer with serde's text, which names internal field types. Every such
/// rejection gets one generic reply instead; the status code stays.
async fn generic_rejections(mut response: Response) -> Response {
    let status = response.status();
    let plain = response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("text/plain"));
    if plain && matches!(status, StatusCode::BAD_REQUEST | StatusCode::UNSUPPORTED_MEDIA_TYPE | StatusCode::UNPROCESSABLE_ENTITY) {
        let body = r#"{"error":"Nieprawidłowe dane żądania."}"#;
        *response.body_mut() = Body::from(body);
        response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        response.headers_mut().insert(CONTENT_LENGTH, HeaderValue::from(body.len()));
    }
    response
}

/// A speech model file never changes in place (a new version gets a new id in its path), so the browser keeps it.
async fn immutable(mut response: Response) -> Response {
    // a stray .html or .js in the models volume never runs as the app (security_headers keeps this policy)
    response.headers_mut().insert(CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox; default-src 'none'"));
    // a 304 repeats the 200's caching headers (RFC 9111 §4.3.4)
    if response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED {
        response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    }
    response
}

// The preview frame (docs/PODGLAD-PLAN.md §2, §3.2): files from other people are parsed and drawn only in a sandboxed
// frame without an origin, which has no network, no storage and no keys. WebKit does not match `'self'` in such a frame,
// so the server's own address is named too; it comes from the same Host/X-Forwarded-* the origin check trusts.
// `connect-src blob:` lets libraries fetch the blob: URLs the frame makes from bytes it already holds (their .wasm). The
// source matches any blob: URL; what keeps others' blobs out is the browser (an opaque origin reads only its own blobs).
// No server, the app's own included, is reachable. Never add report-uri/report-to here: reports would be a way out.
// `sandbox` keeps the origin opaque even when the page is opened on its own, not only inside the app's sandboxed iframe.
// With a known host only `/preview/` may run, not every script of the server; `'self'` is the fallback without one.
fn preview_csp(origin: Option<&str>) -> String {
    let own = origin.map_or_else(|| "'self'".to_string(), |o| format!("{o}/preview/"));
    format!(
        "sandbox allow-scripts; default-src 'none'; script-src {own} 'wasm-unsafe-eval'; worker-src blob:; child-src blob:; \
         style-src {own} 'unsafe-inline'; img-src blob: data:; media-src blob:; font-src blob: data:; connect-src blob:; \
         frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
    )
}

/// `scheme://host` of the request, when its headers name one plainly (a value that could break the policy is refused).
fn request_origin(headers: &HeaderMap) -> Option<String> {
    // a proxy chain may list several hosts and protos; the first is the one the browser used
    let first = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()).map(str::trim);
    let host = first("x-forwarded-host").or_else(|| first("host"))?;
    let proto = first("x-forwarded-proto").unwrap_or("http").to_ascii_lowercase();
    let proto = proto.as_str();
    let plain = !host.is_empty() && host.len() <= 255 && host.bytes().all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b));
    (plain && matches!(proto, "http" | "https")).then(|| format!("{proto}://{host}"))
}

async fn preview_headers(request: Request, next: Next) -> Response {
    let origin = request_origin(request.headers());
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;
    let ok = response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED;
    let h = response.headers_mut();
    if let Ok(csp) = HeaderValue::from_str(&preview_csp(origin.as_deref())) {
        h.insert(CONTENT_SECURITY_POLICY, csp);
    }
    for (name, value) in [
        // the frame's own code is loaded from an opaque origin: CORS and CORP let it in; it carries no data
        ("access-control-allow-origin", "*"),
        ("cross-origin-resource-policy", "cross-origin"),
        ("x-frame-options", "SAMEORIGIN"),
        ("x-dns-prefetch-control", "off"),
        ("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(), display-capture=()"),
    ] {
        h.insert(name, HeaderValue::from_static(value));
    }
    // the page's policy names the host, so it is never kept; its hashed assets never change
    let cache = if path.starts_with("/assets/") && ok { "public, max-age=31536000, immutable" } else { "no-store" };
    h.insert(CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

/// The licence of this server and where its source is (AGPL-3.0 §13: users of a network service may get the source of
/// the version they use). Build-time values: `NOTES_COMMIT` (the git commit) and `NOTES_SOURCE_URL` (the public
/// repository); a build without them answers empty strings. Public, like `/health`.
fn source_info() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "license": "AGPL-3.0-or-later",
        "version": env!("CARGO_PKG_VERSION"),
        "commit": option_env!("NOTES_COMMIT").unwrap_or(""),
        "source": option_env!("NOTES_SOURCE_URL").unwrap_or(""),
    }))
}

/// `models` is the speech model directory on the server's disk (`<data>/models`, docs/DYKTOWANIE.md §7), apart from
/// the built app in `web`, so a new image never carries or re-downloads the models.
pub fn app_with_api(web: Option<&Path>, models: Option<&Path>, api: Router) -> Router {
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/source", get(|| async { source_info() }))
        .merge(api)
        // an unknown `/api/*` path is an error, not the app's index.html with 200
        .route("/api/{*rest}", any(|| async { crate::vaults::VaultError::Missing("Nie ma takiego zasobu.") }))
        .layer(DefaultBodyLimit::max(1 << 20));
    let app = match models {
        // no index.html fallback here: a missing model file is a 404, not the app page the browser would hash
        Some(dir) => app.nest("/models", Router::new().fallback_service(ServeDir::new(dir).append_index_html_on_directories(false)).layer(axum::middleware::map_response(immutable))),
        None => app,
    };
    let app = match web {
        // the preview frame has its own page and headers, and never falls back to the app page
        Some(dir) => {
            let frame = Router::new()
                .fallback_service(ServeDir::new(dir.join("preview")).append_index_html_on_directories(false))
                .layer(axum::middleware::from_fn(preview_headers));
            // `nest` leaves out the bare `/preview/`, which the app's own files would answer without these headers
            app.route("/preview/", get(|| async { axum::response::Redirect::permanent("/preview/index.html") }))
                .nest("/preview", frame)
        }
        None => app,
    };
    let app = match web {
        Some(dir) => app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")))),
        None => app,
    };
    app.layer(axum::middleware::from_fn(trust_forwarded))
        .layer(axum::middleware::map_response(generic_rejections))
        .layer(axum::middleware::map_response(security_headers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{client_of, same_origin};
    use axum::routing::post;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs { map.insert(*name, HeaderValue::from_str(value).unwrap()); }
        map
    }

    #[test]
    fn a_public_peer_cannot_choose_its_client_or_its_origin() {
        let public = Some("203.0.113.9".parse().unwrap());
        let mut first = headers(&[("cf-connecting-ip", "1.1.1.1"), ("x-forwarded-for", "2.2.2.2"), ("x-forwarded-host", "notes.example"), ("x-forwarded-proto", "https"), ("host", "127.0.0.1:8080"), ("origin", "https://notes.example")]);
        let mut second = headers(&[("x-forwarded-for", "3.3.3.3"), ("host", "127.0.0.1:8080"), ("origin", "https://notes.example")]);
        settle_forwarded(&mut first, public);
        settle_forwarded(&mut second, public);
        // every fresh header gives the same bucket: the peer's own address
        assert_eq!(client_of(&first), client_of(&second));
        assert_eq!(client_of(&first), client_of(&headers(&[("x-forwarded-for", "203.0.113.9")])));
        assert!(!same_origin(&first));
    }

    #[test]
    fn a_trusted_proxy_gives_the_rightmost_hop_that_is_not_a_proxy() {
        let docker = Some("172.17.0.1".parse().unwrap());
        let mut forged = headers(&[("x-forwarded-for", "9.9.9.9, 198.51.100.7, 10.0.0.5")]);
        settle_forwarded(&mut forged, docker);
        assert_eq!(client_of(&forged), client_of(&headers(&[("x-forwarded-for", "198.51.100.7")])));
        let mut cloudflare = headers(&[("cf-connecting-ip", "198.51.100.7"), ("x-forwarded-for", "9.9.9.9")]);
        settle_forwarded(&mut cloudflare, Some("127.0.0.1".parse().unwrap()));
        assert_eq!(client_of(&cloudflare), client_of(&headers(&[("cf-connecting-ip", "198.51.100.7")])));
        // no forwarded header at all: the proxy's peer is the client
        let mut direct = HeaderMap::new();
        settle_forwarded(&mut direct, docker);
        assert_eq!(client_of(&direct), client_of(&headers(&[("x-forwarded-for", "172.17.0.1")])));
    }

    #[test]
    fn a_trusted_proxy_decides_the_origin_through_forwarded_host() {
        let mut behind_proxy = headers(&[("x-forwarded-host", "notes.example"), ("x-forwarded-proto", "https"), ("host", "127.0.0.1:8080"), ("origin", "https://notes.example")]);
        settle_forwarded(&mut behind_proxy, Some("127.0.0.1".parse().unwrap()));
        assert!(same_origin(&behind_proxy));
        let mut forged = behind_proxy.clone();
        settle_forwarded(&mut forged, Some("203.0.113.9".parse().unwrap()));
        assert!(!same_origin(&forged));
        assert!(!trusted_peer("8.8.8.8".parse().unwrap()) && trusted_peer("fd00::1".parse().unwrap()) && trusted_peer("::ffff:10.1.2.3".parse().unwrap()));
    }

    #[test]
    fn the_page_may_connect_to_itself_its_own_blobs_and_the_github_api_only() {
        let connect = CSP.split(';').map(str::trim).find(|d| d.starts_with("connect-src")).unwrap_or_default();
        assert_eq!(connect, "connect-src 'self' blob: https://api.github.com");
    }

    #[tokio::test]
    async fn a_json_rejection_gets_one_generic_reply() {
        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct Probe { key_epoch: u32 }
        let app = app_with_api(None, None, Router::new().route("/probe", post(|axum::Json(_): axum::Json<Probe>| async {})));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        let body = r#"{"key_epoch":"nope"}"#;
        let request = format!("POST /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).await.unwrap();
        assert!(reply.starts_with("HTTP/1.1 422"), "{reply}");
        assert!(reply.contains("Nieprawidłowe dane żądania."), "{reply}");
        assert!(!reply.contains("key_epoch") && !reply.contains("invalid type"), "{reply}");
    }

    // One raw GET against a live server, so the reply carries the headers every layer added.
    async fn get(app: Router, path: &str, extra: &str) -> (String, Vec<u8>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{extra}Connection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut reply = Vec::new();
        stream.read_to_end(&mut reply).await.unwrap();
        let split = reply.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&reply[..split]).to_lowercase(), reply[split + 4..].to_vec())
    }

    #[tokio::test]
    async fn the_source_of_this_version_is_named_to_everyone() {
        let (head, body) = get(app_with_api(None, None, Router::new()), "/api/source", "").await;
        assert!(head.starts_with("http/1.1 200"), "{head}");
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["license"], "AGPL-3.0-or-later");
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        assert!(v["commit"].is_string() && v["source"].is_string());
    }

    #[tokio::test]
    async fn speech_models_are_served_immutable_resumable_and_never_as_the_app_page() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("web");
        let models = tmp.path().join("data/models");
        std::fs::create_dir_all(models.join("m1")).unwrap();
        std::fs::create_dir_all(dir.join("models/m1")).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html>app").unwrap();
        let model: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(models.join("m1/a.onnx"), &model).unwrap();
        // a model left in the built app is not served: the server's disk is the one source
        std::fs::write(dir.join("models/m1/old.onnx"), "app").unwrap();
        let app = |dir: Option<&Path>| super::app(dir, Some(&models));

        let (head, body) = get(app(Some(&dir)), "/models/m1/a.onnx", "").await;
        assert!(head.starts_with("http/1.1 200"), "{head}");
        assert!(head.contains("cache-control: public, max-age=31536000, immutable"), "{head}");
        assert!(head.contains("content-type: application/octet-stream"), "{head}");
        assert_eq!(body, model);
        assert!(head.contains("cross-origin-embedder-policy: require-corp"), "{head}");
        assert!(head.contains("content-security-policy: sandbox; default-src 'none'"), "{head}");

        let (head, body) = get(app(Some(&dir)), "/models/m1/a.onnx", "Range: bytes=100-\r\n").await;
        assert!(head.starts_with("http/1.1 206"), "{head}");
        assert_eq!(body, model[100..]);

        let (head, body) = get(app(Some(&dir)), "/models/m1/brak.onnx", "").await;
        assert!(head.starts_with("http/1.1 404"), "{head}");
        assert!(!head.contains("immutable") && !String::from_utf8_lossy(&body).contains("app"), "{head}");

        // a directory or a way out of models/ is never the app page or another file
        for path in ["/models/m1", "/models/m1/", "/models/../index.html", "/models/%2e%2e/index.html", "/models/m1/old.onnx"] {
            let (head, body) = get(app(Some(&dir)), path, "").await;
            assert!(!head.starts_with("http/1.1 2") && !String::from_utf8_lossy(&body).contains("app"), "{path}: {head}");
        }

        let (head, body) = get(app(Some(&dir)), "/", "").await;
        assert!(head.starts_with("http/1.1 200") && body.ends_with(b"app"), "{head}");
        assert!(!head.contains("immutable") && !head.contains("sandbox"), "{head}");
        assert!(head.contains("cross-origin-embedder-policy: require-corp"), "{head}");
        assert!(head.contains("cross-origin-opener-policy: same-origin"), "{head}");
        assert!(head.contains("microphone=(self)") && head.contains("camera=()"), "{head}");
    }

    #[tokio::test]
    async fn the_preview_frame_has_its_own_strict_policy_and_never_the_app_page() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("web");
        std::fs::create_dir_all(dir.join("preview/assets")).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html>app").unwrap();
        std::fs::write(dir.join("preview/index.html"), "<!doctype html>frame").unwrap();
        std::fs::write(dir.join("preview/assets/v-1a2b.js"), "export {}").unwrap();
        let app = || super::app(Some(&dir), None);

        let (head, _) = get(app(), "/preview/", "").await;
        assert!(head.starts_with("http/1.1 308") && head.contains("location: /preview/index.html"), "{head}");
        let (head, body) = get(app(), "/preview/index.html", "").await;
        assert!(head.starts_with("http/1.1 200") && body.ends_with(b"frame"), "{head}");
        let csp = head.lines().find(|l| l.starts_with("content-security-policy:")).unwrap();
        assert!(csp.contains("default-src 'none'") && csp.contains("connect-src blob:;") && csp.contains("frame-ancestors 'self'"), "{csp}");
        assert!(csp.contains("sandbox allow-scripts;") && csp.contains("script-src http://127.0.0.1/preview/ 'wasm-unsafe-eval'"), "{csp}");
        assert!(csp.contains("style-src http://127.0.0.1/preview/ 'unsafe-inline'") && !csp.contains("src 'self'"), "{csp}");
        assert!(csp.contains("img-src blob: data:;") && csp.contains("form-action 'none'") && !csp.contains("https://api.github.com"), "{csp}");
        assert!(head.contains("x-frame-options: sameorigin") && !head.contains("x-frame-options: deny"), "{head}");
        assert!(head.contains("cross-origin-embedder-policy: require-corp"), "{head}");
        assert!(head.contains("access-control-allow-origin: *") && head.contains("cross-origin-resource-policy: cross-origin"), "{head}");
        assert!(head.contains("cache-control: no-store") && head.contains("microphone=()"), "{head}");

        let (head, body) = get(app(), "/preview/assets/v-1a2b.js", "").await;
        assert!(head.starts_with("http/1.1 200") && body == b"export {}", "{head}");
        assert!(head.contains("cache-control: public, max-age=31536000, immutable") && head.contains("connect-src blob:;"), "{head}");

        // a host that would break out of the policy names no host at all
        let (head, _) = get(app(), "/preview/index.html", "X-Forwarded-Host: evil.example; script-src *\r\n").await;
        assert!(head.contains("script-src http://127.0.0.1/preview/"), "{head}");
        assert!(request_origin(&headers(&[("host", "a b")])).is_none());
        assert!(request_origin(&headers(&[("host", "notes.example"), ("x-forwarded-proto", "javascript")])).is_none());
        assert_eq!(request_origin(&headers(&[("host", "notes.example"), ("x-forwarded-proto", "https")])).as_deref(), Some("https://notes.example"));
        assert!(!preview_csp(None).contains("/preview/") && preview_csp(None).contains("script-src 'self' 'wasm-unsafe-eval'"));
        let proxied = headers(&[("x-forwarded-host", "notes.example, inner.local"), ("x-forwarded-proto", "HTTPS, http"), ("host", "127.0.0.1:8090")]);
        assert_eq!(request_origin(&proxied).as_deref(), Some("https://notes.example"));
        assert_eq!(request_origin(&headers(&[("host", "127.0.0.1:8090")])).as_deref(), Some("http://127.0.0.1:8090"));
        // an unusable forwarded host is refused, never replaced by the inner Host
        assert!(request_origin(&headers(&[("x-forwarded-host", "a b"), ("host", "127.0.0.1")])).is_none());
        let (head, _) = get(app(), "/preview/assets/brak.js", "").await;
        assert!(head.starts_with("http/1.1 404") && head.contains("cache-control: no-store"), "{head}");

        // nothing under /preview/ is the app page, and the app page keeps its own policy
        for path in ["/preview/brak.js", "/preview/../index.html", "/preview/%2e%2e/index.html", "/preview/assets/", "/preview/assets"] {
            let (head, body) = get(app(), path, "").await;
            assert!(!String::from_utf8_lossy(&body).contains("app") && head.contains("connect-src blob:;"), "{path}: {head}");
            assert!(!head.contains("location:"), "{path}: a directory never redirects out of /preview/: {head}");
        }
        let (head, _) = get(app(), "/", "").await;
        assert!(head.contains("x-frame-options: deny") && !head.contains("connect-src blob:;") && !head.contains("access-control-allow-origin"), "{head}");
    }
}
