//! Errors the UI shows: a stable `kind` to branch on, and a message (Polish for the user-facing ones).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BridgeError {
    pub kind: &'static str,
    pub message: String,
}

pub type Result<T> = std::result::Result<T, BridgeError>;

impl From<serde_json::Error> for BridgeError {
    fn from(e: serde_json::Error) -> Self { Self::new("invalid_json", format!("Nieprawidłowe dane: {e}")) }
}

impl BridgeError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<notes_core::Error> for BridgeError {
    fn from(e: notes_core::Error) -> Self {
        match e {
            notes_core::Error::PathTaken(p) => {
                Self::new("path_taken", format!("Ścieżka jest zajęta: {p}"))
            }
            notes_core::Error::InvalidPath(p) => {
                Self::new("invalid_path", format!("Nieprawidłowa ścieżka: {p}"))
            }
            notes_core::Error::NotPlainFile(p) => Self::new(
                "invalid_path",
                format!(
                    "Plik notatki {p} jest teraz dowiązaniem, folderem albo nie jest tekstem — nie został odczytany ani nadpisany."
                ),
            ),
            notes_core::Error::NotInConflict(_) => {
                Self::new("not_in_conflict", "Ta notatka nie ma konfliktu.")
            }
            notes_core::Error::UnknownKind(k) => {
                Self::new("invalid_kind", format!("Nieznany typ przestrzeni: {k}"))
            }
            notes_core::Error::KindDowngrade => Self::new(
                "kind_downgrade",
                "Przestrzeni organizacji nie można zmienić z powrotem na notatki.",
            ),
            notes_core::Error::ConflictChanged(_) => Self::new(
                "conflict_changed",
                "Plik zmienił się od otwarcia porównania — wybierz jeszcze raz.",
            ),
            e => Self::new("error", e.to_string()),
        }
    }
}

impl From<notes_sync::Error> for BridgeError {
    fn from(e: notes_sync::Error) -> Self {
        match e {
            notes_sync::Error::NeedsPhrase | notes_sync::Error::NoCertificate => Self::new(
                "needs_phrase",
                "Ta przestrzeń wymaga frazy odzyskiwania na tym komputerze.",
            ),
            notes_sync::Error::NotMember => Self::new(
                "not_member",
                "Ta fraza nie należy do członka tej przestrzeni.",
            ),
            notes_sync::Error::DeviceUnusable => Self::new(
                "device_unusable",
                "Klucz tego komputera został unieważniony w tej przestrzeni albo należy do innego członka. Odzyskanie wymaga nowego klucza urządzenia, czego aplikacja jeszcze nie obsługuje.",
            ),
            notes_sync::Error::Phrase => Self::new(
                "bad_phrase",
                "Fraza odzyskiwania jest nieprawidłowa: sprawdź 24 słowa i ich kolejność.",
            ),
            e => Self::new("error", e.to_string()),
        }
    }
}

impl From<rusqlite::Error> for BridgeError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new("db", format!("Błąd bazy danych: {e}"))
    }
}

impl From<std::io::Error> for BridgeError {
    fn from(e: std::io::Error) -> Self {
        Self::new("io", format!("Błąd pliku: {e}"))
    }
}
