//! End-to-end check of a running node, for `docker/compose.test.yml`. Two devices of one new space
//! (an owner and an editor, in this process) sync through the node over real QUIC, write to the same
//! note, and must end with identical text. Then the node's data directory, mounted read-only, must
//! hold neither the note text nor the note name in clear. Exit 0 when all of it holds, 1 otherwise.

// the same helpers the node integration tests use
#[path = "../../tests/common/mod.rs"]
mod common;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use common::*;
use notes_sync::acl::Role;
use notes_sync::net::connect;
use notes_sync::ticket::NodeTicket;

const NOTE_NAME: &str = "Plan tajny.md";
const NOTE_TEXT: &str = "tajny tekst";

struct Args {
    ticket_file: PathBuf,
    node_data: PathBuf,
}

fn args() -> Result<Args, String> {
    let mut ticket_file = None;
    let mut node_data = None;
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let value = it.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--ticket-file" => ticket_file = Some(PathBuf::from(value)),
            "--node-data" => node_data = Some(PathBuf::from(value)),
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(Args {
        ticket_file: ticket_file.ok_or("--ticket-file is required")?,
        node_data: node_data.ok_or("--node-data is required")?,
    })
}

#[tokio::main]
async fn main() -> ExitCode {
    let result = match args() {
        Ok(args) => run(&args).await,
        Err(message) => Err(message),
    };
    match result {
        Ok(()) => {
            println!("e2e: ok");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("e2e: FAILED: {message}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: &Args) -> Result<(), String> {
    let text = std::fs::read_to_string(&args.ticket_file)
        .map_err(|e| format!("ticket file: {e}"))?;
    let ticket: NodeTicket = text.trim().parse().map_err(|e| format!("ticket: {e}"))?;
    let (a, b) = (
        tempfile::tempdir().map_err(|e| e.to_string())?,
        tempfile::tempdir().map_err(|e| e.to_string())?,
    );
    let mut stores = Team::new(a.path()).invite(b.path(), Role::Editor).into_stores();
    let editor = device(stores.pop().unwrap()).await;
    let owner = device(stores.pop().unwrap()).await;

    let id = {
        let mut st = owner.hub.store();
        let id = st.opened.space.create_note(NOTE_NAME).map_err(|e| e.to_string())?;
        st.opened.space.insert_text(&id, 0, NOTE_TEXT).map_err(|e| e.to_string())?;
        id
    };
    sync_with_retry(&owner, &ticket).await?;
    sync_with_retry(&editor, &ticket).await?;
    if text_of(&editor, &id) != NOTE_TEXT {
        return Err("the editor did not get the text from the node".to_string());
    }

    // both devices stay connected and write live through the node
    let _owner_link = link(&owner, &ticket).await?;
    let _editor_link = link(&editor, &ticket).await?;
    edit(&owner, &id, "A ");
    if !wait_until(|| text_of(&editor, &id) == format!("A {NOTE_TEXT}")).await {
        return Err("the owner's edit did not reach the editor through the node".to_string());
    }
    edit(&editor, &id, "B ");
    if !wait_until(|| text_of(&owner, &id) == format!("B A {NOTE_TEXT}")).await {
        return Err("the editor's edit did not reach the owner through the node".to_string());
    }
    if text_of(&owner, &id) != text_of(&editor, &id) {
        return Err("the two devices have different text".to_string());
    }

    // nothing the node keeps may show the note in clear
    for entry in std::fs::read_dir(&args.node_data).map_err(|e| format!("node data: {e}"))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_file() {
            check_clear(&path, &[NOTE_TEXT.as_bytes(), b"Plan tajny"])?;
        }
    }
    Ok(())
}

async fn link(dev: &Device, ticket: &NodeTicket) -> Result<tokio::task::JoinHandle<notes_sync::Result<()>>, String> {
    let local = dev.identity.local(Some(ticket.node), Some(ticket.token));
    connect(&dev.endpoint, node_addr(ticket), dev.hub.clone(), local)
        .await
        .map_err(|e| e.to_string())
}

/// The node may still be starting; a refused sync is retried for a while before it counts as a failure.
async fn sync_with_retry(dev: &Device, ticket: &NodeTicket) -> Result<(), String> {
    let mut last = String::new();
    for _ in 0..30 {
        match sync(dev, ticket).await {
            Ok(()) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err(format!("sync with the node failed: {last}"))
}

fn check_clear(path: &Path, secrets: &[&[u8]]) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    for secret in secrets {
        if bytes.windows(secret.len()).any(|w| w == *secret) {
            return Err(format!("{} holds the note in clear", path.display()));
        }
    }
    Ok(())
}
