# Zgłaszanie luk bezpieczeństwa

Notatki szyfrują treść end-to-end, a serwer MCP (czat Claude) odszyfrowuje ją na komputerze użytkownika. Lukę w
aplikacji, serwerze `notes-node` albo MCP zgłoś prywatnie, nie w publicznym zgłoszeniu.

- **Jak zgłosić:** w repozytorium na GitHubie wybierz zakładkę **Security** → **Report a vulnerability** (prywatne
  zgłoszenie podatności). Zgłoszenie widzi tylko właściciel projektu; nie zakładaj publicznego zgłoszenia (issue) ani
  nie opisuj luki w dyskusji, dopóki nie ma poprawki.
- Opisz, czego dotyczy luka (aplikacja w przeglądarce, aplikacja na komputer, `notes-node`, MCP), wersję (Ustawienia →
  O programie podaje commit strony i serwera) i jak ją odtworzyć.

Co dalej:
- odpowiedź w ciągu 72 godzin;
- poprawka luki krytycznej w ciągu 7 dni;
- informacja dla klientów po wydaniu poprawki.

Przy luce w MCP operator postępuje według procedury z `docs/DOCKER-WEB.md` („Czaty Claude”): wyłącza czaty, wydaje
poprawkę, podnosi `NOTES_AGENT_MIN_VERSION`, włącza czaty i w razie potrzeby unieważnia wszystkie czaty.

Nie wysyłaj w zgłoszeniu kodów odzyskiwania, haseł, kluczy ani treści cudzych notatek.
