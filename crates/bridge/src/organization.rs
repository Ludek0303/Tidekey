//! Organization commands use certificate identities; handles are display aliases only.
use crate::{Backend, BridgeError, Result};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn key(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Backend {
    pub fn organization_group(&mut self, group: Value) -> Result<()> {
        if self.opened.cert.user != self.opened.acl.owner {
            return Err(BridgeError::new(
                "forbidden",
                "Grupami zarządza Administrator.",
            ));
        }
        let id = group["id"]
            .as_str()
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 100
                    && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
            .ok_or_else(|| BridgeError::new("invalid_group", "Nieprawidłowe ID grupy."))?;
        if group["name"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty() || s.len() > 200)
        {
            return Err(BridgeError::new(
                "invalid_group",
                "Podaj nazwę grupy (do 200 znaków).",
            ));
        }
        let members = group["member_ids"]
            .as_array()
            .ok_or_else(|| BridgeError::new("invalid_group", "Brak listy członków grupy."))?;
        if members.iter().any(|id| {
            !self
                .opened
                .acl
                .members
                .keys()
                .any(|user| id.as_str() == Some(key(user).as_str()))
        }) {
            return Err(BridgeError::new(
                "invalid_group",
                "Grupa może zawierać tylko uczestników przestrzeni.",
            ));
        }
        self.opened.space.patch_structured(
            "@org/admin",
            &BTreeMap::from([(format!("group:{id}"), Some(serde_json::to_string(&group)?))]),
        )?;
        Ok(())
    }
    pub fn replace_task_note_checked(
        &mut self,
        id: &str,
        expected: &str,
        replacement: &str,
    ) -> Result<()> {
        if replacement.len() > 10_000_000 || self.note_text(id)? != expected {
            return Err(BridgeError::new(
                "stale_task",
                "Notatka zmieniła się. Odśwież zadanie przed ponowną edycją.",
            ));
        }
        let people = self.organization_handles()?;
        self.opened
            .space
            .replace_task_note_text(id, replacement, &people)?;
        if let Some(outcome) = self.opened.space.write_file(id)? {
            self.report(Some(id.into()), outcome)?;
        }
        self.search.mark(id);
        self.note_update(id)?;
        Ok(())
    }
    pub(crate) fn organization_handles(&mut self) -> Result<BTreeMap<String, String>> {
        let fields = self.opened.space.structured_fields("@org/admin")?;
        let members = &self.opened.acl.members;
        let mut handles = BTreeMap::new();
        for id in members.keys() {
            let uid = key(id);
            if let Some(name) = fields.get(&format!("person:{uid}")) {
                handles.insert(name.to_lowercase(), uid);
            }
        }
        for (field, uid) in &fields {
            if let Some(name) = field.strip_prefix("alias:")
                && members.keys().any(|id| key(id) == *uid) {
                    handles.insert(name.to_string(), uid.clone());
                }
        }
        Ok(handles)
    }

    pub fn organization_person(&mut self, user_id: &str, name: &str) -> Result<()> {
        if self.opened.cert.user != self.opened.acl.owner {
            return Err(BridgeError::new(
                "forbidden",
                "Nazwy członków ustala Administrator.",
            ));
        }
        if !self.opened.acl.members.keys().any(|id| key(id) == user_id) {
            return Err(BridgeError::new(
                "unknown_member",
                "Nie ma takiego członka w podpisanym rejestrze.",
            ));
        }
        if name.is_empty()
            || name.chars().count() > 64
            || !name
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'))
        {
            return Err(BridgeError::new(
                "invalid_name",
                "Użyj 1–64 liter, cyfr, kropki, _ lub -.",
            ));
        }
        if self
            .organization_handles()?
            .iter()
            .any(|(n, id)| n == &name.to_lowercase() && id != user_id)
        {
            return Err(BridgeError::new(
                "duplicate_name",
                "Ta nazwa jest już przypisana innej osobie.",
            ));
        }
        self.opened.space.patch_structured(
            "@org/admin",
            &BTreeMap::from([
                (format!("person:{user_id}"), Some(name.into())),
                (
                    format!("alias:{}", name.to_lowercase()),
                    Some(user_id.into()),
                ),
            ]),
        )?;
        Ok(())
    }

    pub fn organization_snapshot(&mut self) -> Result<Value> {
        let profiles = self.opened.space.structured_fields("@org/admin")?;
        let handles = self.organization_handles()?;
        let me = key(&self.opened.cert.user);
        let members: Vec<Value> = self.opened.acl.members.iter().map(|(id, member)| {
            let id = key(id);
            json!({"user_id": id, "name": profiles.get(&format!("person:{id}")), "role": format!("{:?}", member.role)})
        }).collect();
        let events: Vec<Value> = self
            .opened
            .space
            .task_events()?
            .into_iter()
            .filter_map(|event| {
                let device: Vec<u8> = (0..event.device.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&event.device[i..i + 2], 16).ok())
                    .collect::<Option<_>>()?;
                let cert = self.opened.certs.get(&device.try_into().ok()?)?;
                let mut value = serde_json::to_value(event).ok()?;
                for side in ["before", "after"] {
                    if let Some(people) = value[side]["people"].as_object_mut() {
                        people.retain(|name, user| {
                            handles.get(&name.to_lowercase()).is_some_and(|expected| {
                                user.as_str() == Some(expected.as_str())
                            })
                        });
                    }
                }
                value["actor_user_id"] = json!(key(&cert.user));
                Some(value)
            })
            .collect();
        let groups: Vec<Value> = profiles
            .iter()
            .filter(|(k, _)| k.starts_with("group:"))
            .filter_map(|(_, v)| serde_json::from_str(v).ok())
            .collect();
        Ok(
            json!({"me": me, "owner": key(&self.opened.acl.owner), "space_id": key(&self.opened.acl.space), "verified": true, "members": members, "handles": handles,
            "groups": groups, "events": events, "fields": self.opened.space.structured_fields("@org/data")?}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MemoryKeyStore;
    use yrs::{Doc, ReadTxn, StateVector, Text, Transact};
    #[test]
    fn task_events_are_signed_with_the_real_actor_and_survive_reopen() {
        let root = tempfile::tempdir().unwrap();
        let mut ks = MemoryKeyStore::default();
        let (mut b, _) = Backend::create(root.path(), &mut ks).unwrap();
        b.set_space_kind("organizacja").unwrap();
        let me = b.organization_snapshot().unwrap()["me"]
            .as_str()
            .unwrap()
            .to_string();
        b.organization_person(&me, "Jan").unwrap();
        let id = b.create_note("Projekt.md").unwrap();
        let doc = Doc::new();
        let text = doc.get_or_insert_text("content");
        text.insert(
            &mut doc.transact_mut(),
            0,
            "- [ ] Build @Jan !trudnosc:8 ^z-1",
        );
        b.apply_update(
            &id,
            &doc.transact()
                .encode_state_as_update_v1(&StateVector::default()),
        )
        .unwrap();
        let before = doc.transact().state_vector();
        {
            let mut tx = doc.transact_mut();
            text.remove_range(&mut tx, 3, 1);
            text.insert(&mut tx, 3, "x");
        }
        b.apply_update(&id, &doc.transact().encode_state_as_update_v1(&before))
            .unwrap();
        let snapshot = b.organization_snapshot().unwrap();
        let events = snapshot["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["actor_user_id"], me);
        assert_eq!(events[1]["after"]["difficulty"], 8);
        assert_eq!(events[1]["after"]["people"]["Jan"], me);
        drop(b);
        let mut reopened = Backend::open(root.path(), &mut ks).unwrap();
        assert_eq!(
            reopened.organization_snapshot().unwrap()["events"],
            snapshot["events"]
        );
    }
}
