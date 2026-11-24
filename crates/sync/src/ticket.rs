//! Node ticket: what a device needs to reach a storage node and to register a space there
//! (DOCKER §4, ARCHITEKTURA §4.18). Text form `notesnode1` + lowercase base32 of the codec encoding.
//! Pure: no sockets, so it builds for the browser too.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::str::FromStr;

use data_encoding::BASE32_NOPAD;

use crate::codec::{Reader, Writer};
use crate::{Error, Result};

const PREFIX: &str = "notesnode1";
const VERSION: u8 = 1;
const MAX_ADDRS: u32 = 16;

#[derive(Clone, PartialEq, Eq)]
pub struct NodeTicket {
    /// Transport public key of the node (its iroh endpoint id).
    pub node: [u8; 32],
    /// Direct addresses of the node, tried in order.
    pub addrs: Vec<SocketAddr>,
    /// Registration token: lets a device create a new space on the node.
    pub token: [u8; 32],
}

impl fmt::Debug for NodeTicket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "NodeTicket {{ addrs: {:?}, token: <secret> }}",
            self.addrs
        )
    }
}

impl NodeTicket {
    fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.u8(VERSION);
        w.bytes(&self.node);
        w.bytes(&self.token);
        w.u32(self.addrs.len() as u32);
        for addr in &self.addrs {
            match addr.ip() {
                IpAddr::V4(ip) => {
                    w.u8(4);
                    w.bytes(&ip.octets());
                }
                IpAddr::V6(ip) => {
                    w.u8(6);
                    w.bytes(&ip.octets());
                }
            }
            w.bytes(&addr.port().to_le_bytes());
        }
        w.0
    }

    fn decode(bytes: &[u8]) -> Result<Self> {
        let mut r = Reader::new(bytes);
        if r.u8()? != VERSION {
            return Err(Error::Malformed("ticket version"));
        }
        let node = r.array()?;
        let token = r.array()?;
        let count = r.count(MAX_ADDRS)?;
        let mut addrs = Vec::with_capacity(count);
        for _ in 0..count {
            let ip = match r.u8()? {
                4 => IpAddr::V4(Ipv4Addr::from(r.array::<4>()?)),
                6 => IpAddr::V6(Ipv6Addr::from(r.array::<16>()?)),
                _ => return Err(Error::Malformed("ticket address family")),
            };
            let port = u16::from_le_bytes(r.array()?);
            addrs.push(SocketAddr::new(ip, port));
        }
        r.finish()?;
        Ok(NodeTicket { node, addrs, token })
    }
}

impl fmt::Display for NodeTicket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let body = BASE32_NOPAD.encode(&self.encode()).to_ascii_lowercase();
        write!(f, "{PREFIX}{body}")
    }
}

impl FromStr for NodeTicket {
    type Err = Error;

    fn from_str(text: &str) -> Result<Self> {
        let body = text
            .strip_prefix(PREFIX)
            .ok_or(Error::Malformed("ticket prefix"))?;
        let bytes = BASE32_NOPAD
            .decode(body.to_ascii_uppercase().as_bytes())
            .map_err(|_| Error::Malformed("ticket encoding"))?;
        Self::decode(&bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket() -> NodeTicket {
        NodeTicket {
            node: [3; 32],
            addrs: vec![
                "192.168.1.5:7842".parse().unwrap(),
                "[2001:db8::1]:7842".parse().unwrap(),
            ],
            token: [4; 32],
        }
    }

    #[test]
    fn round_trips_in_lowercase_text_form() {
        let text = ticket().to_string();
        assert!(text.starts_with("notesnode1"));
        assert_eq!(text, text.to_ascii_lowercase());
        assert_eq!(text.parse::<NodeTicket>().unwrap(), ticket());
        // a pasted ticket with capitals still works
        assert_eq!(
            text.to_ascii_uppercase()
                .replacen("NOTESNODE1", "notesnode1", 1)
                .parse::<NodeTicket>()
                .unwrap(),
            ticket()
        );
    }

    #[test]
    fn garbage_is_rejected() {
        let good = ticket().to_string();
        assert!("".parse::<NodeTicket>().is_err());
        assert!("notesnode1".parse::<NodeTicket>().is_err());
        assert!("notes1:abc".parse::<NodeTicket>().is_err());
        assert!("notesnode1!!!".parse::<NodeTicket>().is_err());
        // every truncation of a valid ticket fails
        for n in 10..good.len() {
            assert!(good[..n].parse::<NodeTicket>().is_err(), "prefix {n}");
        }
        assert!(format!("{good}aa").parse::<NodeTicket>().is_err());
        assert!(
            "notesnode1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .parse::<NodeTicket>()
                .is_err()
        );
    }

    #[test]
    fn debug_hides_the_token() {
        assert!(!format!("{:?}", ticket()).contains("4, 4"));
    }
}
