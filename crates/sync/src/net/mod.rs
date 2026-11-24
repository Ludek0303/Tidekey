//! Transport over iroh (SIEC.md, ARCHITEKTURA §4.7, §4.8): one QUIC connection per pair of peers, one
//! bi-stream carrying `notes-sync/1` frames. Behind the `net` feature; the frames and the state machine
//! it runs live in the pure modules.

mod hub;
mod wire;

#[cfg(test)]
mod tests;

pub use hub::{Hub, Router, SingleHub};
pub use wire::{accept_loop, connect, sync_once};

use std::net::SocketAddr;

use iroh::endpoint::presets::Minimal;
use iroh::{Endpoint, RelayMode, SecretKey};
use zeroize::Zeroizing;

use crate::cert::DeviceCert;
use crate::device::DeviceKeys;
use crate::proto::ALPN;
use crate::session::Local;
use crate::{Error, Result};

/// Transport key of a device. Derived from the device signing key with its own context, so the
/// transport key and the signing key are different keys (no key reuse).
pub fn endpoint_secret(device: &DeviceKeys) -> [u8; 32] {
    let (sign, _) = device.to_seeds();
    blake3::derive_key("notes iroh endpoint v1", &sign[..])
}

/// Transport public key (endpoint id) of a transport secret.
pub fn endpoint_id(secret: &[u8; 32]) -> [u8; 32] {
    *SecretKey::from_bytes(secret).public().as_bytes()
}

/// Opens an endpoint. `addr` None picks any port on all interfaces; `relay` and `mdns` switch the
/// relay servers and LAN discovery on or off.
pub async fn bind(
    secret: [u8; 32],
    addr: Option<SocketAddr>,
    relay: bool,
    mdns: bool,
) -> Result<Endpoint> {
    let mut builder = Endpoint::builder(Minimal)
        .secret_key(SecretKey::from_bytes(&secret))
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(if relay {
            RelayMode::Default
        } else {
            RelayMode::Disabled
        });
    if let Some(addr) = addr {
        builder = builder
            .bind_addr(addr)
            .map_err(|e| Error::Transport(e.to_string()))?;
    }
    if mdns {
        builder = builder.address_lookup(iroh_mdns_address_lookup::MdnsAddressLookup::builder());
    }
    builder
        .bind()
        .await
        .map_err(|e| Error::Transport(e.to_string()))
}

/// What a device needs to act on the network: its keys and certificate, kept as secrets so each
/// connection gets a fresh `Local`.
#[derive(Clone)]
pub struct DeviceIdentity {
    sign: Zeroizing<[u8; 32]>,
    boxk: Zeroizing<[u8; 32]>,
    cert: DeviceCert,
    transport: Zeroizing<[u8; 32]>,
    endpoint: [u8; 32],
}

impl DeviceIdentity {
    pub fn new(keys: &DeviceKeys, cert: DeviceCert) -> Self {
        let (sign, boxk) = keys.to_seeds();
        let transport = Zeroizing::new(endpoint_secret(keys));
        let endpoint = endpoint_id(&transport);
        Self {
            sign,
            boxk,
            cert,
            transport,
            endpoint,
        }
    }

    /// Secret for `bind`.
    pub fn transport_secret(&self) -> [u8; 32] {
        *self.transport
    }

    /// This device's transport public key (its endpoint id).
    pub fn endpoint_id(&self) -> [u8; 32] {
        self.endpoint
    }

    /// The session side of this device. `expected_node` and `token` are set when connecting to a node.
    pub fn local(&self, expected_node: Option<[u8; 32]>, token: Option<[u8; 32]>) -> Local {
        Local::Device {
            keys: DeviceKeys::from_seeds(&self.sign, &self.boxk),
            cert: self.cert,
            endpoint: self.endpoint,
            expected_node,
            token,
        }
    }
}
