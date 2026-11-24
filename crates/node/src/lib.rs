//! The storage node: keeps encrypted spaces it cannot read and relays them between devices (SIEC.md,
//! DOCKER.md). Devices reach it over QUIC (`notes-sync/1`); HTTP serves `/health` and the web app.

pub mod health;
pub mod admin;
pub mod adminweb;
pub mod agents;
pub mod audit;
pub mod files;
pub mod auth;
pub mod http;
pub mod keys;
pub mod leases;
pub mod objstore;
pub mod router;
pub mod run;
pub mod store;
pub mod vaults;
pub mod websync;

// shortcut: not built yet: encrypted snapshots, attachments, join requests kept for an offline owner,
// the node's own relay (`--relay on` uses the n0 relays), compaction (messages are kept forever),
// and the "Dodaj węzeł" entry in the participants log (devices keep the node ticket locally)
