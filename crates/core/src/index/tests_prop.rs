use super::*;
use crate::NoteId;
use proptest::prelude::*;
use std::collections::BTreeMap;

const PATHS: &[&str] = &[
    "Plan.md",
    "A/Plan.md",
    "B/Plan.md",
    "Folder/a.md",
    "Folder/c.md",
    "folder/C.md",
    "Folder/Sub/c.md",
    "Inne/c.md",
    "Zakupy/Łódź.md",
    "Ąę/łódź.md",
    "Top.md",
    "Folder/Ł.md",
];

const TEXTS: &[&str] = &[
    "[[Plan]] [[c]] [u](c.md) [t](../Inne/c.md)",
    "[x](../../c.md) [y](./Sub/c.md) [[Łódź]] [[Zakupy/łódź]]",
    "[[Plan#H]] #a/b #Ż [[ą|x]] - [ ] t @Ola. 📅 2026-10-30",
    "[l](Plan.md) [[Folder/c]] [w](../Plan.md) [[c#H\\|al]]",
    "",
];

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Random upsert/rename/remove sequences give the same answers as a rebuild from the final notes.
    #[test]
    fn incremental_equals_rebuild(
        ops in prop::collection::vec(
            (0u8..3, 0usize..4, 0..PATHS.len(), 0..TEXTS.len()),
            1..40,
        )
    ) {
        let mut idx = SpaceIndex::default();
        let mut model: BTreeMap<NoteId, (String, String)> = BTreeMap::new();
        for (kind, n, p, t) in ops {
            let id = format!("n{n}");
            match kind {
                0 => {
                    idx.upsert(id.clone(), PATHS[p], TEXTS[t]);
                    model.insert(id, (PATHS[p].to_string(), TEXTS[t].to_string()));
                }
                1 => {
                    idx.rename(&id, PATHS[p]);
                    if let Some(entry) = model.get_mut(&id) {
                        entry.0 = PATHS[p].to_string();
                    }
                }
                _ => {
                    idx.remove(&id);
                    model.remove(&id);
                }
            }
        }
        let mut fresh = SpaceIndex::default();
        for (id, (path, text)) in &model {
            fresh.upsert(id.clone(), path, text);
        }
        for n in 0..4 {
            let id = format!("n{n}");
            prop_assert_eq!(idx.outgoing(&id), fresh.outgoing(&id));
            prop_assert_eq!(idx.backlinks(&id), fresh.backlinks(&id));
        }
        prop_assert_eq!(idx.unresolved(), fresh.unresolved());
        prop_assert_eq!(idx.graph(), fresh.graph());
        prop_assert_eq!(idx.tags(), fresh.tags());
    }
}
