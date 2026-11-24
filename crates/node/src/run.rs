//! Starts the node: the QUIC accept loop and the HTTP server, and stops them together.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use notes_sync::net::{Router, accept_loop, bind};
use notes_sync::ticket::NodeTicket;
use notes_sync::{Error, Result};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use zeroize::Zeroizing;

use crate::agents::{AgentService, Config as AgentConfig};
use crate::files::{FileService, Limits, Summary};
use crate::keys;
use crate::objstore;
use crate::router::NodeRouter;
use crate::store::{NodeStore, open_db};
use crate::vaults::VaultLocks;
use crate::websync::BrowserSync;
use crate::{auth::AuthService, vaults::VaultService};

/// The stores every route and the file check share, opened once per process.
pub struct Services {
    pub auth: Arc<AuthService>,
    pub vaults: Arc<VaultService>,
    pub sync: Arc<BrowserSync>,
    pub files: Arc<FileService>,
    pub agents: Arc<AgentService>,
    pub leases: Arc<crate::leases::LeaseService>,
}

/// Opens `auth.db`, the vault and chat tables, `browser-sync.db` and `files.db` in `data`.
pub fn open_services(data: &Path) -> std::result::Result<Services, String> {
    let auth = Arc::new(AuthService::open(data).map_err(|e| format!("authentication database: {e:?}"))?);
    // One lock table for both: puts and member removals/role changes must serialize per vault.
    let vault_locks = Arc::new(VaultLocks::default());
    let vaults = Arc::new(
        VaultService::open(data, vault_locks.clone()).map_err(|e| format!("vault database: {e:?}"))?,
    );
    let sync = Arc::new(
        BrowserSync::open(data, vaults.clone(), vault_locks.clone())
            .map_err(|e| format!("browser sync database: {e:?}"))?,
    );
    let agents = Arc::new(
        AgentService::open(data, sync.clone(), vault_locks, AgentConfig::from_env())
            .map_err(|e| format!("chat tables: {e}"))?,
    );
    let backends = objstore::open_backends(data).map_err(|e| format!("file store: {e}"))?;
    let files = Arc::new(
        FileService::open_backends(data, sync.clone(), Limits::from_env(), backends)
            .map_err(|e| format!("file database: {e:?}"))?,
    );
    let leases = Arc::new(crate::leases::LeaseService::open(data).map_err(|e| format!("lease table: {e:?}"))?);
    // Deleted vaults' snapshots and files go again: a deletion cut short, or a database restored from a backup.
    match vaults.deleted_vault_ids() {
        Ok(ids) => for id in ids { crate::vaults::finish_deletion(&sync, &files, &id) },
        Err(_) => eprintln!("notes-node: lista usuniętych sejfów jest nieczytelna, ponowię przy następnym starcie"),
    }
    Ok(Services { auth, vaults, sync, files, agents, leases })
}

/// `notes-node files-check`: one reconciliation pass, for use while the node is stopped. Opening the services also
/// finishes vault deletions (see open_services), so this command can remove a deleted vault's data.
pub fn files_check(data: &Path) -> std::result::Result<Summary, String> {
    let services = open_services(data)?;
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    runtime.block_on(services.files.reconcile()).map_err(|e| format!("{e:?}"))
}

pub struct Options {
    pub data: PathBuf,
    pub quic: SocketAddr,
    pub http: SocketAddr,
    pub web: Option<PathBuf>,
    pub max_spaces: usize,
    pub max_space_mb: u64,
    /// Connections served at the same time; more wait in the QUIC accept queue.
    pub max_conns: usize,
    pub relay: bool,
    /// The server admin's panel (docs/PANEL-ADMINA.md); needs `NOTES_ADMIN_PASSWORD`. `None`: no panel.
    pub admin_http: Option<SocketAddr>,
}

/// A running node. `shutdown` stops both servers.
pub struct Running {
    pub endpoint: iroh::Endpoint,
    pub http_addr: SocketAddr,
    pub admin_addr: Option<SocketAddr>,
    secret: Zeroizing<[u8; 32]>,
    token: Zeroizing<[u8; 32]>,
    stop_http: oneshot::Sender<()>,
    http: JoinHandle<std::io::Result<()>>,
    admin: Option<(oneshot::Sender<()>, JoinHandle<std::io::Result<()>>)>,
}

pub async fn start(opts: Options) -> Result<Running> {
    let keys = keys::init(&opts.data)?;
    let db = open_db(&opts.data.join("node.db"))?;
    let max_bytes = opts.max_space_mb * 1024 * 1024;
    let router = NodeRouter::open(db, *keys.token, opts.max_spaces, max_bytes)?;
    let endpoint = bind(*keys.secret, Some(opts.quic), opts.relay, false).await?;
    let router: Arc<dyn Router<NodeStore>> = Arc::new(router);
    tokio::spawn(accept_loop(endpoint.clone(), router, opts.max_conns));

    let listener = TcpListener::bind(opts.http)
        .await
        .map_err(|e| Error::Transport(e.to_string()))?;
    let http_addr = listener
        .local_addr()
        .map_err(|e| Error::Transport(e.to_string()))?;
    let (stop_http, stopped) = oneshot::channel::<()>();
    let services = open_services(&opts.data).map_err(Error::Transport)?;
    let admin = match opts.admin_http {
        Some(addr) => {
            let password = Zeroizing::new(std::env::var("NOTES_ADMIN_PASSWORD").unwrap_or_default());
            let panel = crate::adminweb::AdminWeb::new(&opts.data, &password, services.vaults.clone(), services.sync.clone(), services.files.clone())
                .map_err(Error::Transport)?;
            let listener = TcpListener::bind(addr).await.map_err(|e| Error::Transport(e.to_string()))?;
            let local = listener.local_addr().map_err(|e| Error::Transport(e.to_string()))?;
            let app = crate::adminweb::app(Arc::new(panel));
            let (stop, stopped) = oneshot::channel::<()>();
            let task = tokio::spawn(async move {
                axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                    .with_graceful_shutdown(async { let _ = stopped.await; })
                    .await
            });
            Some((local, stop, task))
        }
        None => None,
    };
    crate::files::spawn_reconcile(services.files.clone());
    let api = crate::auth::routes(services.auth.clone())
        .merge(crate::websync::routes(services.auth.clone(), services.sync.clone()))
        .merge(crate::vaults::routes(services.auth.clone(), services.vaults.clone(), services.sync.clone(), services.files.clone()))
        .merge(crate::leases::routes(services.auth.clone(), services.leases))
        .merge(crate::agents::routes(services.auth.clone(), services.agents, services.files.clone()))
        .merge(crate::files::routes(services.auth, services.files));
    let app = crate::http::app_with_api(opts.web.as_deref(), Some(&opts.data.join("models")), api);
    let http = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    Ok(Running {
        endpoint,
        http_addr,
        admin_addr: admin.as_ref().map(|(addr, _, _)| *addr),
        secret: keys.secret,
        token: keys.token,
        stop_http,
        http,
        admin: admin.map(|(_, stop, task)| (stop, task)),
    })
}

impl Running {
    /// The ticket for this node, with the QUIC sockets it actually bound (for tests and local use).
    pub fn ticket(&self) -> NodeTicket {
        NodeTicket {
            node: notes_sync::net::endpoint_id(&self.secret),
            addrs: self
                .endpoint
                .bound_sockets()
                .into_iter()
                .filter(SocketAddr::is_ipv4)
                .map(|s| SocketAddr::from(([127, 0, 0, 1], s.port())))
                .collect(),
            token: *self.token,
        }
    }

    pub async fn shutdown(self) -> std::io::Result<()> {
        let _ = self.stop_http.send(());
        if let Some((stop, task)) = self.admin {
            let _ = stop.send(());
            let _ = task.await;
        }
        let result = self.http.await.unwrap_or(Ok(()));
        self.endpoint.close().await;
        result
    }
}
