//! Field-level CRDT maps carried by the existing signed/encrypted log.
//! These documents have no file path and never produce plaintext Markdown files.
use super::{Space, new_doc};
use crate::{Error, Result};
use std::collections::BTreeMap;
use yrs::{Any, Map, Out, ReadTxn, Transact};

impl Space {
    pub fn replace_task_note_text(
        &mut self,
        id: &str,
        text: &str,
        people: &BTreeMap<String, String>,
    ) -> Result<()> {
        self.check_writable()?;
        let preview = new_doc();
        super::apply(&preview, &self.state(id)?)?;
        let before = preview.transact().state_vector();
        let content = preview.get_or_insert_text(super::CONTENT);
        crate::textdiff::apply(&content, &mut preview.transact_mut(), text);
        let update = preview.transact().encode_state_as_update_v1(&before);
        self.apply_task_update(id, &update, people)
    }
    /// A range diff preserves CRDT anchors outside the edit. The caller checks its expected source hash.
    pub fn replace_note_text(&mut self, id: &str, text: &str) -> Result<Vec<u8>> {
        self.check_writable()?;
        self.load_note(id)?;
        let doc = self.note_doc(id)?;
        let content = doc.get_or_insert_text(super::CONTENT);
        let update = {
            let mut txn = doc.transact_mut();
            crate::textdiff::apply(&content, &mut txn, text);
            txn.encode_update_v1()
        };
        self.append(id, &update)?;
        Ok(update)
    }

    pub fn structured_fields(&mut self, document: &str) -> Result<BTreeMap<String, String>> {
        validate_document(document)?;
        self.load_note(document)?;
        let doc = self.notes.entry(document.into()).or_insert_with(new_doc);
        let fields = doc.get_or_insert_map("fields");
        let txn = doc.transact();
        Ok(fields
            .iter(&txn)
            .filter_map(|(k, v)| match v {
                Out::Any(Any::String(value)) => Some((k.to_string(), value.to_string())),
                _ => None,
            })
            .collect())
    }

    pub fn patch_structured(
        &mut self,
        document: &str,
        fields: &BTreeMap<String, Option<String>>,
    ) -> Result<()> {
        self.patch_structured_audited(document, fields, &[])
    }

    pub fn patch_structured_audited(
        &mut self,
        document: &str,
        fields: &BTreeMap<String, Option<String>>,
        audit: &[u8],
    ) -> Result<()> {
        validate_document(document)?;
        if fields.len() > 1000
            || fields.iter().any(|(k, v)| {
                k.is_empty() || k.len() > 256 || v.as_ref().is_some_and(|s| s.len() > 1_000_000)
            })
        {
            return Err(Error::Layout("invalid structured patch size"));
        }
        self.check_writable()?;
        self.load_note(document)?;
        let doc = self.notes.entry(document.into()).or_insert_with(new_doc);
        let map = doc.get_or_insert_map("fields");
        let update = {
            let mut txn = doc.transact_mut();
            for (key, value) in fields {
                match value {
                    Some(v) => {
                        map.insert(&mut txn, key.as_str(), v.clone());
                    }
                    None => {
                        map.remove(&mut txn, key);
                    }
                }
            }
            txn.encode_update_v1()
        };
        self.append_audited(document, &update, audit)
    }
}

fn validate_document(doc: &str) -> Result<()> {
    if doc == "@org/admin" || doc == "@org/data" {
        Ok(())
    } else {
        Err(Error::Layout("unknown structured document"))
    }
}
