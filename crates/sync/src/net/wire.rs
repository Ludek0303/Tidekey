//! Frames on a QUIC stream and the tasks that run sessions over them.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::{Connection, Incoming, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, EndpointId};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

use super::hub::{Hub, Router};
use crate::proto::{ALPN, Frame, MAX_FRAME, VersionVector};
use crate::session::{Local, Session, SyncStore};
use crate::ticket::NodeTicket;
use crate::{Error, Result};
use tokio::sync::Semaphore;

/// How long a finished side waits for the peer to acknowledge its last bytes.
const FLUSH: Duration = Duration::from_secs(2);
/// The first frame of a connection is a Hello: small, and it must come soon, or the peer is dropped.
const HELLO_MAX: usize = 64 * 1024;
#[cfg(not(test))]
const FIRST_FRAME_WAIT: Duration = Duration::from_secs(10);
#[cfg(test)]
const FIRST_FRAME_WAIT: Duration = Duration::from_secs(2);
/// A session that is not ready this long after its Hello is closed: a peer must not hold a slot for free.
#[cfg(not(test))]
const HANDSHAKE_WAIT: Duration = Duration::from_secs(30);
#[cfg(test)]
const HANDSHAKE_WAIT: Duration = Duration::from_millis(500);
/// Connections one remote endpoint may hold at the same time.
const CONNS_PER_REMOTE: usize = 4;
/// Bytes of a frame are read in steps of this size, so a claimed length alone allocates nothing.
const READ_STEP: usize = 64 * 1024;

fn net_err(e: impl std::fmt::Display) -> Error {
    Error::Transport(e.to_string())
}

/// Writes `u32 LE length ‖ frame`.
async fn write_frame(send: &mut SendStream, frame: &Frame) -> Result<()> {
    let bytes = frame.to_bytes();
    if bytes.len() > MAX_FRAME {
        return Err(Error::Malformed("frame too large"));
    }
    send.write_all(&(bytes.len() as u32).to_le_bytes())
        .await
        .map_err(net_err)?;
    send.write_all(&bytes).await.map_err(net_err)
}

/// Reads one frame of at most `max` bytes. The buffer grows as bytes arrive.
async fn read_frame(recv: &mut RecvStream, max: usize) -> Result<Frame> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await.map_err(net_err)?;
    let n = u32::from_le_bytes(len) as usize;
    if n > max {
        return Err(Error::Malformed("frame too large"));
    }
    let mut buf = Vec::new();
    while buf.len() < n {
        let start = buf.len();
        buf.resize(start + READ_STEP.min(n - start), 0);
        recv.read_exact(&mut buf[start..]).await.map_err(net_err)?;
    }
    Frame::from_bytes(&buf)
}

/// Reads frames on their own task, so that `drive` never cancels a half-read frame. The first frame
/// is limited to a Hello's size; later ones to `MAX_FRAME`.
fn spawn_reader(mut recv: RecvStream) -> mpsc::Receiver<Result<Frame>> {
    let (tx, rx) = mpsc::channel(8);
    tokio::spawn(async move {
        let mut max = HELLO_MAX;
        loop {
            let frame = read_frame(&mut recv, max).await;
            max = MAX_FRAME;
            let failed = frame.is_err();
            if tx.send(frame).await.is_err() || failed {
                break;
            }
        }
    });
    rx
}

/// Gives the peer time to take our last bytes before the connection is dropped.
async fn flush(send: &mut SendStream) {
    let _ = send.finish();
    let _ = tokio::time::timeout(FLUSH, send.stopped()).await;
}

/// Whether `theirs` has at least what we have, for every device.
fn covers(theirs: Option<&VersionVector>, ours: &VersionVector) -> bool {
    missing(theirs, ours).is_empty()
}

/// The devices (first bytes of the key, and the seq the peer lacks) where `theirs` is behind `ours`.
fn missing(theirs: Option<&VersionVector>, ours: &VersionVector) -> Vec<String> {
    ours.iter()
        .filter(|(d, n)| !theirs.is_some_and(|t| t.iter().any(|(td, tn)| td == d && tn >= n)))
        .map(|(d, n)| {
            let key: String = d[..4].iter().map(|b| format!("{b:02x}")).collect();
            format!("{key}… seq {n}")
        })
        .collect()
}

/// Feeds one frame to the session, sends its replies and relays what it stored. Returns true once a
/// sync run is complete: the peer's `Synced` covers our version vector after our second `Have`.
async fn apply<S: SyncStore>(
    hub: &Hub<S>,
    conn: u64,
    session: &mut Session,
    send: &mut SendStream,
    frame: Frame,
    sync: bool,
    asked: &mut Option<VersionVector>,
) -> Result<bool> {
    let synced = matches!(frame, Frame::Synced(_));
    let step = {
        let mut store = hub.store();
        session.on_frame(frame, &mut *store)?
    };
    for frame in &step.send {
        write_frame(send, frame).await?;
    }
    if let Some(reason) = step.close {
        return Err(Error::Transport(reason));
    }
    for msg in step.new {
        hub.publish_from(conn, msg);
    }
    if !(sync && synced) {
        return Ok(false);
    }
    let Some(sent) = asked.clone() else {
        // the backlog we just sent is on its way; ask again so the peer confirms it has all of it
        let ours = hub.store().version_vector()?;
        write_frame(send, &Frame::Have(ours.clone())).await?;
        *asked = Some(ours);
        return Ok(false);
    };
    // the peer answers our second Have with what it has after our backlog; compare with what that Have said
    if covers(session.peer_synced(), &sent) {
        return Ok(true);
    }
    // the peer still lacks something: say what, instead of timing out
    Err(Error::Transport(format!(
        "the node does not have: {}",
        missing(session.peer_synced(), &sent).join(", ")
    )))
}

/// Runs one session until a side closes it. In `sync` mode, returns `Ok(true)` when the sync run is
/// complete and `Ok(false)` if the peer went away first.
async fn drive<S: SyncStore>(
    hub: &Hub<S>,
    conn: u64,
    session: &mut Session,
    send: &mut SendStream,
    mut frames: mpsc::Receiver<Result<Frame>>,
    sync: bool,
    pending: Option<Frame>,
) -> Result<bool> {
    let mut news = hub.subscribe();
    let mut have_again: Option<VersionVector> = None;
    if let Some(frame) = pending
        && apply(hub, conn, session, send, frame, sync, &mut have_again).await?
    {
        return Ok(true);
    }
    let handshake = tokio::time::sleep(HANDSHAKE_WAIT);
    tokio::pin!(handshake);
    loop {
        let finished = tokio::select! {
            frame = frames.recv() => match frame {
                Some(frame) => apply(hub, conn, session, send, frame?, sync, &mut have_again).await?,
                None => return Ok(false),
            },
            _ = &mut handshake, if !session.ready() => {
                return Err(Error::Transport("the peer did not finish the handshake in time".to_string()));
            }
            live = news.recv() => {
                match live {
                    Ok((origin, msg)) if origin != conn => {
                        // the store lock is released before any await
                        let (frame, revoked) = {
                            let store = hub.store();
                            let frame = session.live(&msg, &*store);
                            (frame, session.ready() && !session.allowed(&*store))
                        };
                        // a peer that lost access gets a Reject and no further messages
                        if revoked {
                            let reason = "brak dostępu do przestrzeni";
                            write_frame(send, &Frame::Reject(reason.to_string())).await?;
                            return Err(Error::Transport(reason.to_string()));
                        }
                        if let Some(frame) = frame {
                            write_frame(send, &frame).await?;
                        }
                    }
                    Ok(_) => {}
                    // live messages were dropped: close, so that the next connection exchanges everything again
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        return Err(Error::Transport("live messages were lost; reconnect".to_string()));
                    }
                    Err(broadcast::error::RecvError::Closed) => return Ok(false),
                }
                false
            }
        };
        if finished {
            return Ok(true);
        }
    }
}

/// Opens a session towards a peer and keeps it running in the background. The handle ends when the
/// session does; dropping it does not stop the session.
pub async fn connect<S: SyncStore + 'static>(
    endpoint: &Endpoint,
    addr: EndpointAddr,
    hub: Arc<Hub<S>>,
    local: Local,
) -> Result<JoinHandle<Result<()>>> {
    let conn = endpoint.connect(addr, ALPN).await.map_err(net_err)?;
    let (mut send, recv) = conn.open_bi().await.map_err(net_err)?;
    let remote = *conn.remote_id().as_bytes();
    let id = hub.next_conn();
    let (mut session, hello) = {
        let store = hub.store();
        Session::new(local, remote, &*store)
    };
    write_frame(&mut send, &hello).await?;
    let frames = spawn_reader(recv);
    Ok(tokio::spawn(async move {
        let result = drive(&hub, id, &mut session, &mut send, frames, false, None).await;
        flush(&mut send).await;
        // the reader task may still hold the stream, so the connection is closed explicitly
        conn.close(0u32.into(), b"done");
        result.map(|_| ())
    }))
}

/// Accepts connections until the endpoint closes, at most `max_conns` at a time. Each peer's first frame
/// picks its hub and role; a peer that gets no route is answered with a `Reject`.
pub async fn accept_loop<S: SyncStore + 'static>(
    endpoint: Endpoint,
    router: Arc<dyn Router<S>>,
    max_conns: usize,
) {
    let slots = Arc::new(Semaphore::new(max_conns));
    let remotes = RemoteSlots::default();
    while let Some(incoming) = endpoint.accept().await {
        let Ok(permit) = slots.clone().acquire_owned().await else {
            break;
        };
        let router = router.clone();
        let remotes = remotes.clone();
        tokio::spawn(async move {
            // a peer that fails the handshake or sends garbage is simply dropped
            let _ = serve(incoming, router, remotes).await;
            drop(permit);
        });
    }
}

/// Live connections per remote endpoint id.
type RemoteSlots = Arc<std::sync::Mutex<HashMap<[u8; 32], usize>>>;

/// One of a remote's connections; released when the connection's task ends.
struct RemoteSlot {
    slots: RemoteSlots,
    remote: [u8; 32],
}

impl RemoteSlot {
    fn take(slots: &RemoteSlots, remote: [u8; 32]) -> Option<Self> {
        let mut map = slots.lock().unwrap_or_else(|e| e.into_inner());
        let held = map.entry(remote).or_insert(0);
        if *held >= CONNS_PER_REMOTE {
            return None;
        }
        *held += 1;
        Some(Self {
            slots: slots.clone(),
            remote,
        })
    }
}

impl Drop for RemoteSlot {
    fn drop(&mut self) {
        let mut map = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(held) = map.get_mut(&self.remote) {
            *held -= 1;
            if *held == 0 {
                map.remove(&self.remote);
            }
        }
    }
}

async fn serve<S: SyncStore>(
    incoming: Incoming,
    router: Arc<dyn Router<S>>,
    remotes: RemoteSlots,
) -> Result<()> {
    let conn = incoming.accept().map_err(net_err)?.await.map_err(net_err)?;
    let result = serve_conn(&conn, router, remotes).await;
    // closed on every path: a reader task may still hold the stream, which keeps the connection open
    conn.close(0u32.into(), b"done");
    result
}

async fn serve_conn<S: SyncStore>(
    conn: &Connection,
    router: Arc<dyn Router<S>>,
    remotes: RemoteSlots,
) -> Result<()> {
    let remote = *conn.remote_id().as_bytes();
    // a fifth connection from the same endpoint is dropped before it can take a first frame
    let Some(_slot) = RemoteSlot::take(&remotes, remote) else {
        return Ok(());
    };
    let (mut send, recv) = tokio::time::timeout(FIRST_FRAME_WAIT, conn.accept_bi())
        .await
        .map_err(|_| Error::Transport("no first frame".to_string()))?
        .map_err(net_err)?;
    let mut frames = spawn_reader(recv);
    let first = tokio::time::timeout(FIRST_FRAME_WAIT, frames.recv())
        .await
        .map_err(|_| Error::Transport("no first frame".to_string()))?;
    let Some(first) = first else {
        return Ok(());
    };
    let first = first?;
    let Some((hub, local)) = router.route(&first, remote) else {
        write_frame(&mut send, &Frame::Reject("nieznana przestrzeń".to_string())).await?;
        flush(&mut send).await;
        return Ok(());
    };
    let id = hub.next_conn();
    let (mut session, hello) = {
        let store = hub.store();
        Session::new(local, remote, &*store)
    };
    write_frame(&mut send, &hello).await?;
    let _ = drive(
        &hub,
        id,
        &mut session,
        &mut send,
        frames,
        false,
        Some(first),
    )
    .await;
    flush(&mut send).await;
    conn.close(0u32.into(), b"done");
    Ok(())
}

/// Runs one sync with a node (or any device serving the space) and returns once the peer has
/// everything we have. Errors if the peer refuses, closes early, or the timeout passes.
pub async fn sync_once<S: SyncStore + 'static>(
    endpoint: &Endpoint,
    ticket: &NodeTicket,
    hub: Arc<Hub<S>>,
    local: Local,
    timeout: Duration,
) -> Result<()> {
    let node = EndpointId::from_bytes(&ticket.node).map_err(net_err)?;
    let addr = ticket
        .addrs
        .iter()
        .fold(EndpointAddr::new(node), |addr, sock| {
            addr.with_ip_addr(*sock)
        });
    let run = run_sync(endpoint, ticket.node, addr, hub, local);
    match tokio::time::timeout(timeout, run).await {
        Ok(result) => result,
        Err(_) => Err(Error::Transport("sync timed out".to_string())),
    }
}

async fn run_sync<S: SyncStore + 'static>(
    endpoint: &Endpoint,
    node: [u8; 32],
    addr: EndpointAddr,
    hub: Arc<Hub<S>>,
    local: Local,
) -> Result<()> {
    let conn = endpoint.connect(addr, ALPN).await.map_err(net_err)?;
    let (mut send, recv) = conn.open_bi().await.map_err(net_err)?;
    let id = hub.next_conn();
    let (mut session, hello) = {
        let store = hub.store();
        Session::new(local, node, &*store)
    };
    write_frame(&mut send, &hello).await?;
    let frames = spawn_reader(recv);
    let result = drive(&hub, id, &mut session, &mut send, frames, true, None).await;
    flush(&mut send).await;
    conn.close(0u32.into(), b"done");
    match result? {
        true => Ok(()),
        false => Err(Error::Transport(
            "peer closed before the sync finished".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_and_missing_compare_per_device() {
        let (a, b) = ([1u8; 32], [2u8; 32]);
        let ours: VersionVector = vec![(a, 3), (b, 5)];
        assert!(covers(Some(&vec![(a, 3), (b, 9)]), &ours));
        assert!(!covers(Some(&vec![(a, 2), (b, 9)]), &ours));
        assert!(!covers(Some(&vec![(a, 3)]), &ours));
        assert!(!covers(None, &ours));
        assert!(covers(None, &Vec::new()));
        let behind = missing(Some(&vec![(a, 3)]), &ours);
        assert_eq!(behind.len(), 1);
        assert!(behind[0].ends_with("seq 5"));
    }
}
