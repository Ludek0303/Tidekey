//! The node's two secrets, kept in the data directory (DOCKER §7): `node.key` is the transport
//! secret, `token` lets devices register a new space. Both are 32 random bytes, mode 0600 on Unix.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use notes_sync::net::endpoint_id;
use notes_sync::ticket::NodeTicket;
use notes_sync::{Error, Result, random};
use zeroize::Zeroizing;

pub struct NodeKeys {
    pub secret: Zeroizing<[u8; 32]>,
    pub token: Zeroizing<[u8; 32]>,
}

/// Reads both secrets, creating any that are missing. Safe to repeat: existing secrets are kept.
pub fn init(dir: &Path) -> Result<NodeKeys> {
    fs::create_dir_all(dir).map_err(io_err)?;
    Ok(NodeKeys {
        secret: read_or_create(&dir.join("node.key"))?,
        token: read_or_create(&dir.join("token"))?,
    })
}

/// Writes the ticket text to `path` with the same private mode and atomic rename as the keys.
pub fn write_ticket(path: &Path, ticket: &NodeTicket) -> Result<()> {
    write_private(path, format!("{ticket}\n").as_bytes())
}

/// The ticket a device pastes to reach this node: node id, public address (if given) and token.
pub fn ticket(dir: &Path, public_addr: Option<SocketAddr>) -> Result<NodeTicket> {
    let keys = init(dir)?;
    Ok(NodeTicket {
        node: endpoint_id(&keys.secret),
        addrs: public_addr.into_iter().collect(),
        token: *keys.token,
    })
}

fn read_or_create(path: &Path) -> Result<Zeroizing<[u8; 32]>> {
    match fs::read(path) {
        Ok(bytes) => {
            let bytes = Zeroizing::new(bytes);
            let secret: [u8; 32] = bytes[..]
                .try_into()
                .map_err(|_| Error::Store(format!("{} is not 32 bytes", path.display())))?;
            Ok(Zeroizing::new(secret))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let secret = Zeroizing::new(random::<32>()?);
            write_private(path, &secret[..])?;
            Ok(secret)
        }
        Err(e) => Err(io_err(e)),
    }
}

/// Writes through a temp file that is synced, renamed over the old name, and the directory synced, so a
/// crash never leaves a short key or a rename that is lost.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp: PathBuf = {
        let mut name = path.as_os_str().to_owned();
        name.push(".tmp");
        name.into()
    };
    // a temp file left by a crash keeps its old mode (mode applies only to new files), so it goes first
    match fs::remove_file(&tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_err(e)),
    }
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp).map_err(io_err)?;
    file.write_all(bytes).map_err(io_err)?;
    file.sync_all().map_err(io_err)?;
    drop(file);
    fs::rename(&tmp, path).map_err(io_err)?;
    sync_dir(path.parent())
}

/// fsync of the directory, so the rename itself survives a crash (Unix; Windows has no such call).
fn sync_dir(dir: Option<&Path>) -> Result<()> {
    #[cfg(unix)]
    {
        let dir = match dir {
            Some(d) if !d.as_os_str().is_empty() => d,
            _ => Path::new("."),
        };
        fs::File::open(dir)
            .and_then(|d| d.sync_all())
            .map_err(io_err)?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

fn io_err(e: io::Error) -> Error {
    Error::Store(e.to_string())
}
