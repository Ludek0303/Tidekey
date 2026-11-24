//! Structured module state, with an authenticated operation log and deterministic Markdown snapshots.
use crate::{Backend, BridgeError, Result};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn invalid(message: &str) -> BridgeError {
    BridgeError::new("invalid_record", message)
}
fn string<'a>(v: &'a Value, field: &str) -> Result<&'a str> {
    v[field]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| invalid(&format!("Brak pola: {field}")))
}
pub(crate) fn records(fields: &BTreeMap<String, String>) -> BTreeMap<String, Value> {
    let mut result: BTreeMap<String, Value> = BTreeMap::new();
    for (key, value) in fields {
        let Some(rest) = key.strip_prefix("record/") else {
            continue;
        };
        let Some((id, field)) = rest.split_once('/') else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(value) else {
            continue;
        };
        result.entry(id.into()).or_insert_with(|| json!({}))[field] = value;
    }
    result
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 140
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub(crate) fn revision(value: Option<&Value>) -> String {
    blake3::hash(&serde_json::to_vec(&value).expect("JSON value"))
        .to_hex()
        .to_string()
}
fn module<'a>(all: &'a BTreeMap<String, Value>, record: &Value, kind: &str) -> Result<&'a Value> {
    let id = string(record, "module_id")?;
    all.get(id)
        .filter(|r| r["kind"] == kind && r["deleted"] != true)
        .ok_or_else(|| invalid("Nie ma modułu docelowego."))
}

pub(crate) fn validate(record: &Value, all: &BTreeMap<String, Value>) -> Result<()> {
    if !record.is_object() || serde_json::to_vec(record)?.len() > 100_000 {
        return Err(invalid("Rekord jest zbyt duży lub nieprawidłowy."));
    }
    if !valid_id(string(record, "id")?) {
        return Err(invalid("Nieprawidłowy identyfikator."));
    }
    let kind = string(record, "kind")?;
    match kind {
        "calendar" | "inventory" => {
            string(record, "name")?;
        }
        "event" => {
            module(all, record, "calendar")?;
            string(record, "name")?;
            let start = chrono::DateTime::parse_from_rfc3339(string(record, "start")?)
                .map_err(|_| invalid("Nieprawidłowy początek wydarzenia."))?;
            let end = chrono::DateTime::parse_from_rfc3339(string(record, "end")?)
                .map_err(|_| invalid("Nieprawidłowy koniec wydarzenia."))?;
            if end <= start {
                return Err(invalid("Koniec musi być późniejszy niż początek."));
            }
            string(record, "timezone")?
                .parse::<chrono_tz::Tz>()
                .map_err(|_| invalid("Nieprawidłowa strefa czasowa IANA."))?;
            if let Some(rrule) = record.get("rrule").and_then(Value::as_str)
                && !matches!(rrule, "" | "FREQ=DAILY" | "FREQ=WEEKLY") {
                    return Err(invalid(
                        "Obsługiwane powtarzanie: codziennie lub co tydzień.",
                    ));
                }
            if !record["participants"].is_array() {
                return Err(invalid("Brak listy uczestników."));
            }
            if let Some(exceptions) = record.get("exceptions") {
                for date in exceptions
                    .as_array()
                    .ok_or_else(|| invalid("Wyjątki muszą być listą dat."))?
                {
                    chrono::NaiveDate::parse_from_str(date.as_str().unwrap_or(""), "%Y-%m-%d")
                        .map_err(|_| invalid("Nieprawidłowa data wyjątku."))?;
                }
            }
        }
        "item" => {
            module(all, record, "inventory")?;
            string(record, "name")?;
            string(record, "category")?;
            string(record, "location")?;
            string(record, "unit")?;
            let qty = record["quantity"]
                .as_f64()
                .ok_or_else(|| invalid("Ilość musi być liczbą."))?;
            if !qty.is_finite() || qty < 0.0 {
                return Err(invalid("Ilość nie może być ujemna."));
            }
            if let Some(status) = record.get("status")
                && !matches!(
                    status.as_str(),
                    Some("available" | "repair" | "damaged" | "retired")
                ) {
                    return Err(invalid("Nieprawidłowy status sprzętu."));
                }
        }
        "availability" => {
            string(record, "user_id")?;
            string(record, "timezone")?
                .parse::<chrono_tz::Tz>()
                .map_err(|_| invalid("Nieprawidłowa strefa czasowa."))?;
            let slots = record["weekly_slots"]
                .as_array()
                .ok_or_else(|| invalid("Brak tygodniowej dostępności."))?;
            for slot in slots {
                let day = slot["day"].as_u64().filter(|n| *n <= 6);
                let start = slot["start"].as_u64().filter(|n| *n < 1440);
                let end = slot["end"].as_u64().filter(|n| *n <= 1440);
                if day.is_none() || start.is_none() || end.is_none() || start >= end {
                    return Err(invalid("Nieprawidłowy przedział dostępności."));
                }
            }
            if let Some(overrides) = record.get("date_overrides") {
                for slot in overrides
                    .as_array()
                    .ok_or_else(|| invalid("Wyjątki muszą być listą."))?
                {
                    chrono::NaiveDate::parse_from_str(
                        slot["date"].as_str().unwrap_or(""),
                        "%Y-%m-%d",
                    )
                    .map_err(|_| invalid("Nieprawidłowa data wyjątku."))?;
                    let start = slot["start"].as_u64().filter(|n| *n < 1440);
                    let end = slot["end"].as_u64().filter(|n| *n <= 1440);
                    if start.is_none()
                        || end.is_none()
                        || start >= end
                        || !slot["available"].is_boolean()
                    {
                        return Err(invalid("Nieprawidłowy przedział wyjątku."));
                    }
                }
            }
        }
        "rsvp" => {
            let event = string(record, "event_id")?;
            if !all.get(event).is_some_and(|r| r["kind"] == "event") {
                return Err(invalid("Nie ma takiego wydarzenia."));
            }
            if all[event]["module_id"] != record["module_id"] {
                return Err(invalid("Odpowiedź należy do kalendarza wydarzenia."));
            }
            string(record, "user_id")?;
            if !matches!(record["response"].as_str(), Some("yes" | "maybe" | "no")) {
                return Err(invalid("Nieprawidłowa odpowiedź."));
            }
        }
        "settings" => {
            // one record per organization; 0 months = done tasks are never removed (ui/src/taskretention.ts)
            let months = record["task_retention_months"].as_u64();
            // optional: who besides administrators sees the activity view (ui/src/taskretention.ts)
            let visibility = &record["activity_visibility"];
            if string(record, "id")? != "org-settings"
                || !months.is_some_and(|m| m <= 120)
                || (!visibility.is_null() && !matches!(visibility.as_str(), Some("admins" | "members")))
            {
                return Err(invalid("Nieprawidłowe ustawienia organizacji."));
            }
        }
        _ => return Err(invalid("Nieznany rodzaj rekordu.")),
    }
    Ok(())
}

/// The fenced JSON is complete and restorable; the table is a readable projection of the same records.
pub(crate) fn markdown(
    module: &Value,
    all: &BTreeMap<String, Value>,
    operations: &[Value],
) -> String {
    let id = module["id"].as_str().unwrap_or("");
    let entries: Vec<_> = all
        .values()
        .filter(|r| r["module_id"] == id)
        .cloned()
        .collect();
    let history: Vec<_> = operations
        .iter()
        .filter(|op| op["record"]["after"]["module_id"] == id)
        .cloned()
        .collect();
    let escape = |v: &Value| {
        v.as_str()
            .unwrap_or("")
            .replace('|', "\\|")
            .replace('\n', " ")
    };
    let mut out = format!(
        "---\ntyp: {}\nid: {}\nschema: notes-module-v1\n---\n\n# {}\n\n",
        module["kind"].as_str().unwrap_or(""),
        id,
        escape(&module["name"])
    );
    out.push_str("| ID | Nazwa | Początek / lokalizacja | Koniec / ilość |\n|---|---|---|---|\n");
    for r in entries.iter().filter(|r| r["deleted"] != true) {
        out.push_str(&format!(
            "| {} | {} | {} | {} |\n",
            escape(&r["id"]),
            escape(&r["name"]),
            escape(r.get("start").unwrap_or(&r["location"])),
            r.get("end")
                .map(escape)
                .unwrap_or_else(|| r["quantity"].to_string())
        ));
    }
    out.push_str("\n## Pełny zapis danych\n\n```json\n");
    out.push_str(&serde_json::to_string_pretty(&json!({"schema": "notes-module-v1", "module": module, "records": entries, "history": history})).expect("JSON value"));
    out.push_str("\n```\n");
    out
}

impl Backend {
    pub fn organization_import_module(
        &mut self,
        text: &str,
        expected: Option<&str>,
        commit: bool,
    ) -> Result<Value> {
        if text.len() > 2_000_000 {
            return Err(invalid("Import przekracza limit 2 MB."));
        }
        let json_text = text
            .split("```json\n")
            .nth(1)
            .and_then(|s| s.split("\n```").next())
            .ok_or_else(|| invalid("Brak pełnego bloku danych JSON w Markdown."))?;
        let data: Value = serde_json::from_str(json_text)?;
        if data["schema"] != "notes-module-v1" {
            return Err(invalid("Nieobsługiwany schemat Markdown."));
        }
        let module = &data["module"];
        let module_id = string(module, "id")?;
        if !matches!(module["kind"].as_str(), Some("calendar" | "inventory")) {
            return Err(invalid("Import wymaga modułu kalendarza lub inwentarza."));
        }
        let fields = self.opened.space.structured_fields("@org/data")?;
        let all = records(&fields);
        let version = revision(Some(&serde_json::to_value(&all)?));
        let entries = data["records"]
            .as_array()
            .filter(|a| a.len() <= 100)
            .ok_or_else(|| invalid("Import obsługuje do 100 rekordów na raz."))?;
        let mut incoming = BTreeMap::from([(module_id.to_string(), module.clone())]);
        for r in entries {
            let id = string(r, "id")?;
            if r["module_id"] != module_id || incoming.insert(id.into(), r.clone()).is_some() {
                return Err(invalid("Powtórzone ID lub rekord innego modułu."));
            }
        }
        let mut candidate = all.clone();
        candidate.extend(incoming.clone());
        let mut patch = BTreeMap::new();
        let mut audit = Vec::new();
        for (id, r) in &incoming {
            if !valid_id(id) {
                return Err(invalid("Nieprawidłowy identyfikator."));
            }
            if r["kind"] == "movement" {
                if all.get(id).is_some_and(|old| old != r) {
                    return Err(invalid(
                        "Zapisanej operacji magazynowej nie można zmienić przez import.",
                    ));
                }
                if !r["issue"].is_boolean()
                    || r["quantity"]
                        .as_f64()
                        .is_none_or(|q| !q.is_finite() || q <= 0.0)
                    || !candidate
                        .get(r["item_id"].as_str().unwrap_or(""))
                        .is_some_and(|item| {
                            item["kind"] == "item" && item["module_id"] == module_id
                        })
                {
                    return Err(invalid("Nieprawidłowa operacja magazynowa."));
                }
            } else if r["kind"] == "movement_cancel" {
                if self.opened.cert.user != self.opened.acl.owner {
                    return Err(invalid("Import korekt magazynowych wymaga Administratora."));
                }
                if !candidate
                    .get(r["target_id"].as_str().unwrap_or(""))
                    .is_some_and(|target| {
                        target["kind"] == "movement" && target["module_id"] == module_id
                    })
                {
                    return Err(invalid("Korekta odwołuje się do nieznanej operacji."));
                }
                string(r, "reason")?;
            } else {
                validate(r, &candidate)?;
            }
            let old = all.get(id);
            if old.is_some_and(|old| old["kind"] != r["kind"] || old["module_id"] != r["module_id"])
            {
                return Err(invalid(
                    "Import nie może przenieść ID do innego modułu ani zmienić rodzaju.",
                ));
            }
            if old == Some(r) {
                continue;
            }
            audit.push(json!({"before": old, "after": r, "imported": true}));
            for (field, value) in r
                .as_object()
                .ok_or_else(|| invalid("Nieprawidłowy rekord."))?
            {
                patch.insert(
                    format!("record/{id}/{field}"),
                    Some(serde_json::to_string(value)?),
                );
            }
            if let Some(old) = old {
                for field in old.as_object().unwrap().keys() {
                    if r.get(field).is_none() {
                        patch.insert(format!("record/{id}/{field}"), None);
                    }
                }
            }
        }
        // Import is additive. Omitting a record never silently erases data or an operation.
        let mut operations = self.organization_verified_operations()?;
        operations.extend(audit.iter().map(|r| json!({"record":r})));
        for (id, item) in candidate
            .iter()
            .filter(|(_, r)| r["kind"] == "item" && r["module_id"] == module_id)
        {
            let total = item["quantity"].as_f64().unwrap_or(0.0);
            let available = balance(id, total, &operations);
            if available < 0.0 || available > total {
                return Err(invalid("Import tworzyłby konflikt stanu magazynowego."));
            }
        }
        if commit {
            if expected != Some(version.as_str()) {
                return Err(BridgeError::new(
                    "record_conflict",
                    "Dane zmieniły się od podglądu importu. Porównaj je ponownie.",
                ));
            }
            if !patch.is_empty() {
                patch.insert(
                    format!("markdown/{module_id}"),
                    Some(markdown(module, &candidate, &operations)),
                );
                if let Some(history) = data.get("history") {
                    patch.insert(
                        format!("import-history/{module_id}"),
                        Some(serde_json::to_string(history)?),
                    );
                }
                self.opened.space.patch_structured_audited(
                    "@org/data",
                    &patch,
                    &serde_json::to_vec(&json!({"records":audit}))?,
                )?;
            }
        }
        Ok(json!({"version":version,"name":module["name"],"changes":audit,"committed":commit}))
    }

    pub fn organization_records(&mut self) -> Result<Value> {
        let fields = self.opened.space.structured_fields("@org/data")?;
        let all = records(&fields);
        let operations = self.organization_verified_operations()?;
        let snapshots: BTreeMap<_, _> = all
            .iter()
            .filter(|(_, r)| matches!(r["kind"].as_str(), Some("calendar" | "inventory")))
            .map(|(id, r)| (id.clone(), markdown(r, &all, &operations)))
            .collect();
        let revisions: BTreeMap<_, _> = all
            .iter()
            .map(|(id, r)| (id.clone(), revision(Some(r))))
            .collect();
        Ok(
            json!({"records": all, "revisions": revisions, "markdown": snapshots, "operations": operations, "empty_revision": revision(None)}),
        )
    }

    pub fn organization_verified_operations(&self) -> Result<Vec<Value>> {
        let mut ops = self.opened.space.organization_operations()?;
        ops.retain_mut(|op| {
            let Some(device) = op["device"].as_str() else {
                return false;
            };
            let bytes: Option<Vec<u8>> = (0..device.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&device[i..i + 2], 16).ok())
                .collect();
            let Some(bytes) = bytes.and_then(|b| b.try_into().ok()) else {
                return false;
            };
            let Some(cert) = self.opened.certs.get(&bytes) else {
                return false;
            };
            if op["record"]["after"]["kind"] == "movement_cancel"
                && cert.user != self.opened.acl.owner
            {
                return false;
            }
            op["actor_user_id"] = json!(
                cert.user
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            );
            true
        });
        ops.sort_by_key(|op| {
            (
                op["time_ms"].as_u64().unwrap_or(0),
                op["event_id"].as_str().unwrap_or("").to_string(),
            )
        });
        Ok(ops)
    }

    pub fn organization_save_record(&mut self, record: Value, expected: &str) -> Result<Value> {
        let fields = self.opened.space.structured_fields("@org/data")?;
        let all = records(&fields);
        validate(&record, &all)?;
        let id = string(&record, "id")?;
        let old = all.get(id);
        if revision(old) != expected {
            return Err(BridgeError::new(
                "record_conflict",
                "Rekord zmienił się. Odśwież dane przed zapisem.",
            ));
        }
        if old.is_some_and(|r| r["kind"] != record["kind"] || r["module_id"] != record["module_id"])
        {
            return Err(invalid("Rodzaj i moduł rekordu są stałe."));
        }
        let me: String = self
            .opened
            .cert
            .user
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if matches!(record["kind"].as_str(), Some("availability" | "rsvp"))
            && record["user_id"] != me
        {
            return Err(invalid(
                "Możesz zapisać tylko własną dostępność lub odpowiedź.",
            ));
        }
        if record["kind"] == "availability" && id != format!("availability-{me}") {
            return Err(invalid("Dostępność ma jeden stały identyfikator na osobę."));
        }
        if record["kind"] == "rsvp"
            && id != format!("rsvp-{}-{me}", record["event_id"].as_str().unwrap_or(""))
        {
            return Err(invalid(
                "Odpowiedź ma stały identyfikator wydarzenia i osoby.",
            ));
        }
        if record["kind"] == "event" {
            let users: Vec<String> = self
                .opened
                .acl
                .members
                .keys()
                .map(|id| id.iter().map(|b| format!("{b:02x}")).collect())
                .collect();
            if record["participants"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| !users.iter().any(|id| p.as_str() == Some(id)))
            {
                return Err(invalid("Uczestnik musi należeć do tej przestrzeni."));
            }
        }
        if record["kind"] == "item" && old.is_some_and(|r| r["quantity"] != record["quantity"])
            && self
                .organization_verified_operations()?
                .iter()
                .any(|op| op["record"]["after"]["item_id"] == id)
            {
                return Err(invalid(
                    "Po pierwszym wydaniu ilość bazowa jest stała. Użyj nowej pozycji dla dodatkowego zapasu.",
                ));
            }
        self.commit_record(record, old.cloned())?;
        self.organization_records()
    }

    fn commit_record(&mut self, record: Value, old: Option<Value>) -> Result<()> {
        let fields = self.opened.space.structured_fields("@org/data")?;
        let mut all = records(&fields);
        let id = string(&record, "id")?.to_string();
        let mut patch = BTreeMap::new();
        for (field, value) in record
            .as_object()
            .ok_or_else(|| invalid("Nieprawidłowy rekord."))?
        {
            if old.as_ref().and_then(|r| r.get(field)) != Some(value) {
                patch.insert(
                    format!("record/{id}/{field}"),
                    Some(serde_json::to_string(value)?),
                );
            }
        }
        if let Some(old) = &old {
            for field in old.as_object().unwrap().keys() {
                if record.get(field).is_none() {
                    patch.insert(format!("record/{id}/{field}"), None);
                }
            }
        }
        if patch.is_empty() {
            return Ok(());
        }
        let audit = json!({"record": {"before": old, "after": record}});
        all.insert(id.clone(), record.clone());
        let mut operations = self.organization_verified_operations()?;
        operations.push(json!({"record": audit["record"]}));
        let module_id = record["module_id"].as_str().unwrap_or(&id);
        if let Some(module) = all
            .get(module_id)
            .filter(|r| matches!(r["kind"].as_str(), Some("calendar" | "inventory")))
        {
            patch.insert(
                format!("markdown/{module_id}"),
                Some(markdown(module, &all, &operations)),
            );
        }
        self.opened.space.patch_structured_audited(
            "@org/data",
            &patch,
            &serde_json::to_vec(&audit)?,
        )?;
        Ok(())
    }

    pub fn organization_movement(
        &mut self,
        id: &str,
        item_id: &str,
        quantity: f64,
        issue: bool,
        borrower: &str,
    ) -> Result<Value> {
        if !valid_id(id) || !quantity.is_finite() || quantity <= 0.0 {
            return Err(invalid("Podaj dodatnią ilość i poprawne ID operacji."));
        }
        let all = records(&self.opened.space.structured_fields("@org/data")?);
        let item = all
            .get(item_id)
            .filter(|r| r["kind"] == "item" && r["deleted"] != true)
            .ok_or_else(|| invalid("Nie ma takiej pozycji."))?;
        let total = item["quantity"].as_f64().unwrap_or(0.0);
        if issue && item.get("status").is_some_and(|s| s != "available") {
            return Err(invalid("Sprzęt w tym stanie nie może zostać wydany."));
        }
        let operations = self.organization_verified_operations()?;
        if let Some(op) = operations
            .iter()
            .find(|op| op["record"]["after"]["id"] == id)
        {
            let previous = &op["record"]["after"];
            if previous["item_id"] != item_id
                || previous["quantity"] != quantity
                || previous["issue"] != issue
                || previous["borrower"] != borrower
            {
                return Err(invalid("ID operacji zostało już użyte."));
            }
            return self.organization_records();
        }
        let available = balance(item_id, total, &operations);
        let next = available + if issue { -quantity } else { quantity };
        if available < 0.0 || available > total || next < 0.0 || next > total {
            return Err(BridgeError::new(
                "inventory_conflict",
                "Operacja przekracza stan magazynu lub istnieje konflikt. Sprawdź historię wydań.",
            ));
        }
        let movement = json!({"id": id, "kind": "movement", "module_id": item["module_id"], "item_id": item_id,
            "quantity": quantity, "issue": issue, "borrower": borrower});
        self.commit_record(movement, None)?;
        self.organization_records()
    }

    pub fn organization_cancel_movement(&mut self, target_id: &str, reason: &str) -> Result<Value> {
        if self.opened.cert.user != self.opened.acl.owner {
            return Err(BridgeError::new(
                "forbidden",
                "Korektę operacji zatwierdza Administrator.",
            ));
        }
        if reason.trim().is_empty() || reason.len() > 1000 {
            return Err(invalid("Podaj uzasadnienie korekty (do 1000 znaków)."));
        }
        let ops = self.organization_verified_operations()?;
        let target = ops
            .iter()
            .map(|op| &op["record"]["after"])
            .find(|r| r["kind"] == "movement" && r["id"] == target_id)
            .ok_or_else(|| invalid("Nie ma takiej operacji magazynowej."))?;
        if ops.iter().any(|op| {
            op["record"]["after"]["kind"] == "movement_cancel"
                && op["record"]["after"]["target_id"] == target_id
        }) {
            return self.organization_records();
        }
        let correction = json!({"id":format!("cancel-{target_id}"),"kind":"movement_cancel","target_id":target_id,"item_id":target["item_id"],"module_id":target["module_id"],"reason":reason});
        self.commit_record(correction, None)?;
        self.organization_records()
    }
}

pub(crate) fn balance(item: &str, total: f64, operations: &[Value]) -> f64 {
    let mut seen = std::collections::HashSet::new();
    let cancelled: std::collections::HashSet<_> = operations
        .iter()
        .filter_map(|op| {
            let r = &op["record"]["after"];
            if r["kind"] == "movement_cancel" {
                r["target_id"].as_str()
            } else {
                None
            }
        })
        .collect();
    total
        + operations
            .iter()
            .filter_map(|op| {
                let r = &op["record"]["after"];
                if r["kind"] != "movement"
                    || r["item_id"] != item
                    || cancelled.contains(r["id"].as_str()?)
                    || !seen.insert(r["id"].as_str()?)
                {
                    return None;
                }
                let q = r["quantity"].as_f64()?;
                Some(if r["issue"] == true { -q } else { q })
            })
            .sum::<f64>()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn organization_settings_hold_a_bounded_task_retention() {
        let ok = |r: Value| validate(&r, &BTreeMap::new()).is_ok();
        assert!(ok(json!({"id":"org-settings","kind":"settings","task_retention_months":12})));
        assert!(ok(json!({"id":"org-settings","kind":"settings","task_retention_months":0})));
        assert!(!ok(json!({"id":"other","kind":"settings","task_retention_months":12})));
        assert!(!ok(json!({"id":"org-settings","kind":"settings","task_retention_months":121})));
        assert!(!ok(json!({"id":"org-settings","kind":"settings","task_retention_months":-1})));
        assert!(!ok(json!({"id":"org-settings","kind":"settings"})));
        assert!(ok(json!({"id":"org-settings","kind":"settings","task_retention_months":0,"activity_visibility":"members"})));
        assert!(ok(json!({"id":"org-settings","kind":"settings","task_retention_months":0,"activity_visibility":"admins"})));
        assert!(!ok(json!({"id":"org-settings","kind":"settings","task_retention_months":0,"activity_visibility":"everyone"})));
        assert!(!ok(json!({"id":"org-settings","kind":"settings","task_retention_months":0,"activity_visibility":true})));
    }
    #[test]
    fn modules_are_persisted_and_edits_use_optimistic_concurrency() {
        let root = tempfile::tempdir().unwrap();
        let mut keys = crate::MemoryKeyStore::default();
        let (mut backend, _) = Backend::create(root.path(), &mut keys).unwrap();
        backend.set_space_kind("organizacja").unwrap();
        let module = json!({"id":"lab","kind":"inventory","name":"Lab"});
        backend
            .organization_save_record(module.clone(), &revision(None))
            .unwrap();
        assert!(
            backend
                .organization_save_record(module, &revision(None))
                .is_err()
        );
        let item = json!({"id":"drone","kind":"item","module_id":"lab","name":"Drone","category":"UAV","location":"Hangar / półka A","unit":"szt.","quantity":1});
        backend
            .organization_save_record(item, &revision(None))
            .unwrap();
        backend
            .organization_movement("issue-1", "drone", 1.0, true, "user")
            .unwrap();
        assert!(
            backend
                .organization_movement("issue-2", "drone", 1.0, true, "user")
                .is_err()
        );
        let before = backend.organization_records().unwrap();
        assert!(
            before["markdown"]["lab"]
                .as_str()
                .unwrap()
                .contains("issue-1")
        );
        drop(backend);
        let mut reopened = Backend::open(root.path(), &mut keys).unwrap();
        assert_eq!(reopened.organization_records().unwrap(), before);
        assert!(reopened.list_tree().unwrap().notes.is_empty());
    }
    #[test]
    fn concurrent_last_item_issues_are_a_conflict_and_replay_is_idempotent() {
        let a = json!({"record":{"after":{"id":"a","kind":"movement","item_id":"drone","quantity":1,"issue":true}}});
        let b = json!({"record":{"after":{"id":"b","kind":"movement","item_id":"drone","quantity":1,"issue":true}}});
        assert_eq!(balance("drone", 1.0, &[a.clone(), a.clone()]), 0.0);
        assert_eq!(balance("drone", 1.0, &[a, b]), -1.0);
    }
    #[test]
    fn markdown_contains_complete_records_and_history() {
        let m = json!({"id":"cal","kind":"calendar","name":"Spotkania"});
        let event = json!({"id":"evt","kind":"event","module_id":"cal","name":"Plan","timezone":"Europe/Warsaw","participants":["user-1"],"exceptions":["2026-11-01"]});
        let md = markdown(&m, &BTreeMap::from([("evt".into(), event.clone())]), &[]);
        let data: Value = serde_json::from_str(
            md.split("```json\n")
                .nth(1)
                .unwrap()
                .split("\n```")
                .next()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(data["records"][0], event);
    }
}
