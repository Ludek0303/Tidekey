//! Task events and the source edit are committed in a single signed/encrypted message.
//! Actors, event ids and timestamps come from verified message headers, never from the UI.
use super::{Space, apply, new_doc};
use crate::{
    Error, Result,
    index::{Task, parse_note},
    message, message_hash,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use yrs::{GetString, Transact};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskSnapshot {
    pub task_id: String,
    pub title: String,
    pub assignees: Vec<String>,
    #[serde(default)]
    pub groups: Vec<String>,
    pub supervisor: Option<String>,
    pub difficulty: Option<u8>,
    pub due: Option<i32>,
    pub done: bool,
    pub completed_on: Option<i32>,
    /// Stable certificate user ids, captured at the time of the event. Unknown legacy handles stay unmapped.
    pub people: BTreeMap<String, String>,
}

impl TaskSnapshot {
    fn of(t: &Task, people: &BTreeMap<String, String>) -> Self {
        let names = t.assignees.iter().chain(t.supervisor.iter());
        Self {
            task_id: t.id.clone().unwrap(),
            title: t.text.clone(),
            assignees: t.assignees.clone(),
            groups: t.groups.clone(),
            supervisor: t.supervisor.clone(),
            difficulty: t.difficulty,
            due: t.due,
            done: t.done,
            completed_on: t.done_on,
            people: names
                .filter_map(|n| {
                    people
                        .get(&n.to_lowercase())
                        .map(|id| (n.clone(), id.clone()))
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Change {
    kind: String,
    #[serde(default)]
    clock: BTreeMap<String, u64>,
    before: Option<TaskSnapshot>,
    after: TaskSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskEvent {
    pub event_id: String,
    pub note_id: String,
    pub device: String,
    pub time_ms: u64,
    pub kind: String,
    pub clock: BTreeMap<String, u64>,
    pub before: Option<TaskSnapshot>,
    pub after: TaskSnapshot,
}

fn unique_tasks(text: &str) -> BTreeMap<String, Task> {
    let mut out = BTreeMap::new();
    let mut duplicates = HashSet::new();
    for t in parse_note(text).tasks {
        if let Some(id) = &t.id {
            if out.contains_key(id) {
                duplicates.insert(id.clone());
            }
            out.insert(id.clone(), t);
        }
    }
    for id in duplicates {
        out.remove(&id);
    }
    out
}

fn changes(before: &str, after: &str, people: &BTreeMap<String, String>) -> Vec<Change> {
    let old = unique_tasks(before);
    let legacy = parse_note(before).tasks;
    let mut out = Vec::new();
    for (id, task) in unique_tasks(after) {
        // Giving an existing task an id does not invent a historical delegation or completion.
        let previous = old.get(&id).or_else(|| {
            let matches: Vec<_> = legacy
                .iter()
                .filter(|t| t.id.is_none() && t.text == task.text)
                .collect();
            (matches.len() == 1).then(|| matches[0])
        });
        let snapshot = TaskSnapshot::of(&task, people);
        let before = previous.map(|t| {
            let mut t = t.clone();
            t.id = Some(id.clone());
            TaskSnapshot::of(&t, people)
        });
        let mut kinds = Vec::new();
        if previous.map_or(!task.assignees.is_empty() || !task.groups.is_empty(), |p| {
            p.assignees != task.assignees || p.groups != task.groups
        }) {
            kinds.push("TaskAssigned");
        }
        if previous.is_some_and(|p| !p.done && task.done) {
            kinds.push("TaskCompleted");
        }
        if previous.is_some_and(|p| p.done && !task.done) {
            kinds.push("TaskReopened");
        }
        if previous.is_some_and(|p| p.due != task.due) {
            kinds.push("TaskDueChanged");
        }
        if previous.is_some_and(|p| p.supervisor != task.supervisor) {
            kinds.push("TaskSupervisorChanged");
        }
        if previous.is_some_and(|p| p.difficulty != task.difficulty) {
            kinds.push("TaskDifficultyChanged");
        }
        for kind in kinds {
            out.push(Change {
                kind: kind.into(),
                clock: BTreeMap::new(),
                before: before.clone(),
                after: snapshot.clone(),
            });
        }
    }
    out
}

impl Space {
    pub fn apply_task_update(
        &mut self,
        id: &str,
        update: &[u8],
        people: &BTreeMap<String, String>,
    ) -> Result<()> {
        self.check_writable()?;
        let before = self.text(id)?;
        // Preview on a separate document: a malformed update cannot partially change the open note.
        let preview = new_doc();
        apply(&preview, &self.state(id)?)?;
        apply(&preview, update)?;
        let after = preview
            .get_or_insert_text(super::CONTENT)
            .get_string(&preview.transact());
        let mut events = changes(&before, &after, people);
        if !events.is_empty() {
            let clock: BTreeMap<_, _> = self
                .version_vector()?
                .into_iter()
                .map(|(device, seq)| (hex::encode(device), seq))
                .collect();
            for event in &mut events {
                event.clock = clock.clone();
            }
        }
        let audit = serde_json::to_vec(&events).map_err(|e| Error::Crdt(e.to_string()))?;
        apply(self.note_doc(id)?, update)?;
        self.append_audited(id, update, &audit)
    }

    /// Rebuilt from the immutable log: overwriting a CRDT field cannot remove or forge history.
    pub fn task_events(&self) -> Result<Vec<TaskEvent>> {
        let rows = self.messages()?;
        let mut messages = Vec::with_capacity(rows.len());
        for bytes in rows {
            messages.push((
                bytes.clone(),
                message::open(&bytes, &self.space_id, |e| self.access.key(e))?,
            ));
        }
        let mut out = Vec::new();
        for (bytes, m) in &messages {
            // Keep history after a task moves to another note or its old note is deleted.
            // Consumers intersect task ids with the current authorized task index.
            if m.audit.is_empty() {
                continue;
            }
            if self
                .access
                .accept(&m.header, &message_hash(bytes))
                .is_err()
                || self.access.accept_document(&m.header, &m.doc).is_err()
            {
                continue;
            }
            let data: serde_json::Value =
                serde_json::from_slice(&m.audit).map_err(|e| Error::Crdt(e.to_string()))?;
            if !data.is_array() {
                continue;
            }
            let changes: Vec<Change> =
                serde_json::from_value(data).map_err(|e| Error::Crdt(e.to_string()))?;
            if !audit_matches(self, m, &changes, &messages)? {
                continue;
            }
            for (i, change) in changes.into_iter().enumerate() {
                out.push(TaskEvent {
                    event_id: format!("{}:{}:{i}", hex::encode(m.header.device), m.header.seq),
                    note_id: m.doc.clone(),
                    device: hex::encode(m.header.device),
                    time_ms: m.time_ms,
                    kind: change.kind,
                    clock: change.clock,
                    before: change.before,
                    after: change.after,
                });
            }
        }
        out.sort_by(|a, b| (a.time_ms, &a.event_id).cmp(&(b.time_ms, &b.event_id)));
        Ok(out)
    }

    /// Authenticated record operations; callers resolve the device through the certificate store.
    pub fn organization_operations(&self) -> Result<Vec<serde_json::Value>> {
        let mut out = Vec::new();
        for bytes in self.messages()? {
            let m = message::open(&bytes, &self.space_id, |e| self.access.key(e))?;
            if m.doc != "@org/data" || m.audit.is_empty() {
                continue;
            }
            if self
                .access
                .accept(&m.header, &message_hash(&bytes))
                .is_err()
                || self.access.accept_document(&m.header, &m.doc).is_err()
            {
                continue;
            }
            let data: serde_json::Value =
                serde_json::from_slice(&m.audit).map_err(|e| Error::Crdt(e.to_string()))?;
            let records: Vec<_> = data
                .get("record")
                .into_iter()
                .chain(
                    data.get("records")
                        .and_then(|r| r.as_array())
                        .into_iter()
                        .flatten(),
                )
                .collect();
            for (i, record) in records.into_iter().enumerate() {
                out.push(serde_json::json!({ "event_id": format!("{}:{}:{i}", hex::encode(m.header.device), m.header.seq),
                    "device": hex::encode(m.header.device), "time_ms": m.time_ms, "record": record }));
            }
        }
        Ok(out)
    }
}

/// The outer Ed25519 signature binds an audit to its sender, but does not prove the audit describes
/// the CRDT update. Recompute the task transitions at the signed causal frontier before exposing it.
fn audit_matches(
    space: &Space,
    current: &message::Opened,
    claimed: &[Change],
    history: &[(Vec<u8>, message::Opened)],
) -> Result<bool> {
    if claimed.is_empty() || claimed.iter().any(|change| change.clock != claimed[0].clock) {
        return Ok(false);
    }
    let frontier = &claimed[0].clock;
    let sender = hex::encode(current.header.device);
    if frontier.get(&sender).copied().unwrap_or(0).saturating_add(1) != current.header.seq {
        return Ok(false);
    }

    // Reject a frontier that skips or relies on a message this device cannot authenticate.
    for (device, limit) in frontier {
        let mut sequences = Vec::new();
        for (bytes, message) in history {
            if hex::encode(message.header.device) == *device && message.header.seq <= *limit {
                if space.access.accept(&message.header, &message_hash(bytes)).is_err()
                    || space.access.accept_document(&message.header, &message.doc).is_err()
                {
                    return Ok(false);
                }
                sequences.push(message.header.seq);
            }
        }
        sequences.sort_unstable();
        if sequences.len() != *limit as usize
            || sequences.iter().enumerate().any(|(index, seq)| *seq != index as u64 + 1)
        {
            return Ok(false);
        }
    }

    let document = new_doc();
    for (bytes, prior) in history {
        if prior.header.device == current.header.device && prior.header.seq == current.header.seq {
            continue;
        }
        if prior.doc != current.doc
            || !frontier
                .get(&hex::encode(prior.header.device))
                .is_some_and(|limit| prior.header.seq <= *limit)
            || space.access.accept(&prior.header, &message_hash(bytes)).is_err()
            || space.access.accept_document(&prior.header, &prior.doc).is_err()
        {
            continue;
        }
        apply(&document, &prior.payload)?;
    }
    let content = document.get_or_insert_text(super::CONTENT);
    let before = content.get_string(&document.transact());
    apply(&document, &current.payload)?;
    let after = content.get_string(&document.transact());

    // Stable user ids in the snapshots are checked against the signed member directory by the
    // bridge. Core verifies every content and state field against the update itself.
    let mut expected = changes(&before, &after, &BTreeMap::new());
    let mut actual = claimed.to_vec();
    for event in &mut expected {
        event.clock.clear();
    }
    for event in &mut actual {
        event.clock.clear();
        if let Some(snapshot) = &mut event.before {
            snapshot.people.clear();
        }
        event.after.people.clear();
    }
    Ok(expected == actual)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_changes_are_separate_and_completion_keeps_rating() {
        let a = "- [ ] Build @Jan !nadzor:@Anna !trudnosc:0 ^z-1";
        let b = "- [x] Build @Piotr !nadzor:@Anna !trudnosc:8 📅 2026-11-05 ^z-1";
        let events = changes(
            a,
            b,
            &BTreeMap::from([("piotr".into(), "stable-user".into())]),
        );
        assert_eq!(events.len(), 4);
        let done = events.iter().find(|e| e.kind == "TaskCompleted").unwrap();
        assert_eq!(done.after.difficulty, Some(8));
        assert_eq!(done.after.people["Piotr"], "stable-user");
        assert!(changes(b, b, &BTreeMap::new()).is_empty());
    }
    #[test]
    fn legacy_or_duplicate_tasks_do_not_invent_history() {
        assert!(
            changes(
                "- [x] Build @Jan",
                "- [x] Build @Jan ^z-1",
                &BTreeMap::new()
            )
            .is_empty()
        );
        assert!(
            changes(
                "",
                "- [ ] A @Jan ^z-1\n- [ ] B @Anna ^z-1",
                &BTreeMap::new()
            )
            .is_empty()
        );
    }
    #[test]
    fn assigning_a_group_is_an_assignment_event() {
        let events = changes(
            "- [ ] Build ^z-1",
            "- [ ] Build !grupa:team-123 ^z-1",
            &BTreeMap::new(),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "TaskAssigned");
        assert_eq!(events[0].after.groups, vec!["team-123"]);
    }
}
