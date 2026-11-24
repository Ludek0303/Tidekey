# Szyfrowanie end-to-end i kopia na węźle

Jak dane są szyfrowane, żeby **węzeł przechowujący (serwer) nie mógł ich odczytać ani podrobić**, i w jakiej kolejności to zbudować. Zbiera i uściśla ARCHITEKTURA §4.9–4.12, §4.16 i §4.18 oraz SIEC §4 i §7. Miejsca **[decyzja]** są do potwierdzenia (lista w [UWAGI.md](UWAGI.md)).

Biblioteki: tylko gotowe, sprawdzone implementacje — `ed25519-dalek`, `chacha20poly1305` (XChaCha20-Poly1305, `aead::stream`), `crypto_box` (sealed box, X25519), `blake3` (`derive_key`), `bip39`, `zeroize`. Żadnych własnych algorytmów.

---

## 1. Zasada w trzech zdaniach

1. Każda zmiana jest **szyfrowana na urządzeniu autora**, zanim zapisze się w jego bazie i zanim gdziekolwiek poleci. Klucz przestrzeni mają tylko uczestnicy.
2. Szyfrogram jest **podpisany** kluczem urządzenia. Dzięki temu węzeł może sprawdzić, *kto* wysłał wiadomość i czy wolno mu pisać — bez możliwości przeczytania, *co* wysłał.
3. Lokalny dziennik trzyma **dokładnie te bajty, które idą przez sieć**. Kopia na węzeł, przekazanie dalej i odtworzenie z kopii to kopiowanie gotowych wiadomości — nic nie trzeba ponownie szyfrować.

## 2. Klucze

```text
fraza odzyskiwania (24 słowa, BIP39)
   └─▶ ziarno (64 B)
        ├─ derive_key("notes user-sign v1") ─▶ klucz użytkownika Ed25519   (podpisy: certyfikaty urządzeń, dziennik uczestników)
        └─ derive_key("notes user-box v1")  ─▶ klucz użytkownika X25519    (odbieranie kopert z kluczem przestrzeni)

klucz urządzenia Ed25519 (losowy, osobny na każdej instalacji)
   └─ certyfikat urządzenia = podpis klucza użytkownika nad (klucz urządzenia, data)

klucz przestrzeni[epoka] (losowe 32 B)
   └─ koperta dla każdego uczestnika = crypto_box sealed box do jego klucza X25519
```

| Klucz | Gdzie leży | Kto go ma | Węzeł? |
|---|---|---|---|
| użytkownika (oba) | systemowy magazyn haseł; odtwarzalny z frazy | właściciel konta | ❌ |
| urządzenia | systemowy magazyn haseł | to jedno urządzenie | ❌ (zna tylko klucz publiczny) |
| przestrzeni[epoka] | w kopertach w dzienniku uczestników; w pamięci odszyfrowany | uczestnicy | ❌ (przechowuje tylko koperty, nie umie ich otworzyć) |

Dwa klucze użytkownika wyprowadzamy osobno z ziarna (zamiast przerabiać Ed25519 na X25519) — każdy klucz do jednego celu.

## 3. Wiadomość — format w sieci, w lokalnej bazie i na węźle

```text
nagłówek (jawny, 85 B):
  wersja formatu (1 B) = 1
  id przestrzeni (16 B)
  klucz publiczny urządzenia (32 B)
  seq (8 B)              ← kolejny numer tego urządzenia
  epoka klucza (4 B)
  nonce (24 B, losowy)

szyfrogram = XChaCha20-Poly1305(
    klucz = klucz przestrzeni[epoka], nonce, AAD = nagłówek,
    tekst = dopełnienie({ id notatki, aktualizacja Yrs }) )

podpis (64 B) = Ed25519(klucz urządzenia, nagłówek ‖ szyfrogram)
```

- **Id notatki jest w środku szyfrogramu** — węzeł nie wie nawet, której notatki dotyczy zmiana.
- **Dopełnienie** do wielokrotności 256 B ukrywa długość pojedynczych edycji (inaczej z rozmiarów dałoby się zgadywać, ile znaków ktoś wpisał) [decyzja: rozmiar kubełka].
- **Indeks lokalny w `space.db`** — `doc_index` (id notatki i czas autorstwa każdej wiadomości) i `note_usage` (czas ostatniego otwarcia notatki) służą tylko do ładowania notatek i nie opuszczają urządzenia. W przestrzeni otwartej są jawne, bo `file_state` już trzyma id i ścieżki notatek (ARCHITEKTURA §4.10), a czasy są metadanymi aktywności na tym urządzeniu. W przestrzeni zaszyfrowanej obejmuje je SQLCipher (ARCHITEKTURA §4.17).
- **Tekst notatek poza wiadomościami w `space.db`** (etap 2, pkt 11–12) — w przestrzeni otwartej trzy tabele trzymają jawny tekst: `file_base` (tekst ostatniego zapisu pliku, baza scalania trójstronnego, ARCHITEKTURA §4.4), `versions` (historia wersji; tekst spakowany zstd, nie zaszyfrowany) oraz `conflicts` (tekst zewnętrzny w konflikcie). Plik `.md` i tak leży na dysku jawnie, więc ta kopia nic nie ujawnia ponad to, co już jest w folderze. Wiadomości (`messages`) pozostają zaszyfrowane, a sekrety nigdy nie trafiają do `space.db`. W przestrzeni zaszyfrowanej wszystkie te tabele obejmuje SQLCipher, a `file_base` nie jest potrzebny, bo nie ma plików `.md`. Indeks FTS5 (ARCHITEKTURA §4.15) również trzyma tekst w `space.db` i podlega tej samej regule.
- **Najpierw szyfrowanie, potem podpis** — węzeł weryfikuje podpis bez klucza przestrzeni.
- **Certyfikaty urządzeń** nie są w każdej wiadomości (to ~100 B na każdą paczkę). Urządzenie wysyła swój certyfikat w `Hello`, a uczestnicy i węzeł przechowują je i przekazują dalej razem z wiadomościami danego urządzenia (zmiana względem ARCHITEKTURA §4.10) [decyzja].

Kolejność sprawdzania u odbiorcy (uczestnika i węzła):

| Krok | Uczestnik | Węzeł |
|---|---|---|
| 1. podpis pasuje do klucza urządzenia | ✅ | ✅ |
| 2. certyfikat podpisał użytkownik z przestrzeni, nieunieważniony | ✅ | ✅ |
| 3. użytkownik jest **teraz** edytorem lub właścicielem | ✅ | ✅ |
| 4. szyfrogram odszyfrowuje się kluczem z epoki | ✅ | ❌ nie ma klucza |

Jedna porażka = odrzucenie. Węzeł zatrzymuje więc śmieci i wiadomości od obcych oraz czytelników, choć nie zna treści.

## 4. Co trzyma węzeł

```text
notes-node.db
├── spaces       id przestrzeni, limity
├── acl_log      podpisane wpisy dziennika uczestników (koperty z kluczem są w środku, zaszyfrowane)
├── devices      certyfikaty urządzeń
├── messages     (przestrzeń, urządzenie, seq) → bajty wiadomości 1:1 jak w §3
├── snapshots    zaszyfrowana migawka stanu + wektor wersji, podpisana przez urządzenie uczestnika
├── blobs        zaszyfrowane załączniki, adresowane skrótem BLAKE3 szyfrogramu
└── join_requests  prośby o dołączenie (gdy właściciel offline)
```

**Migawka** (dla nowych urządzeń i do odtworzenia z kopii): któreś urządzenie uczestnika co jakiś czas [decyzja: raz na dobę albo po 10 000 wiadomości] koduje pełny stan (dokument `meta` + stany wszystkich notatek Yrs + wektor wersji), dopełnia, szyfruje bieżącą epoką i podpisuje. Węzeł trzyma najnowszą i może usunąć wiadomości, które migawka już obejmuje.

**Załączniki:** plik szyfrowany strumieniowo (`aead::stream`, fragmenty 64 KiB) kluczem przestrzeni z losowym nonce; skrót liczony z **szyfrogramu**, więc dwa identyczne pliki nie zdradzają, że są takie same. W `meta` (zaszyfrowanej) zapisuje się `ścieżka → skrót`.

**Kopia zapasowa** — urządzenia w różnych sieciach i tak wysyłają każdą wiadomość na żywo przez węzeł (SIEC §3), więc kopia powstaje od razu. Gdy wszyscy online są w jednym LAN, wysyłka na węzeł idzie przy starcie, co 5 minut i przy zamykaniu (ARCHITEKTURA §4.18): wymiana wektorów wersji, potem brakujące wiadomości i certyfikaty. Ponieważ lokalny dziennik trzyma bajty z §3, to zwykłe kopiowanie wierszy.

## 5. Co serwer widzi, a czego nie

| | Węzeł widzi? |
|---|---|
| treść notatek, nazwy, ścieżki, tagi, linki | ❌ |
| której notatki dotyczy zmiana | ❌ |
| załączniki, ich nazwy, czy dwa pliki są takie same | ❌ |
| klucz przestrzeni, klucze prywatne | ❌ |
| id przestrzeni, klucze publiczne uczestników i urządzeń, role | ✅ (potrzebne do odrzucania obcych) |
| kiedy i ile ktoś pisze (z dokładnością do kubełka 256 B) | ✅ |
| adresy IP łączących się urządzeń | ✅ |

Czego węzeł **nie może**: odczytać, podrobić ani zmienić wiadomości (podpis), dopisać uczestnika (dziennik podpisuje tylko właściciel). Co **może**: wstrzymać lub skasować kopię albo podawać starszy stan. Urządzenia pamiętają swoje wektory wersji, więc cofnięcie wykryją („węzeł ma mniej, niż już mu wysłałem”) i wyślą brakujące ponownie. Edycja na żywo i tak idzie z pominięciem węzła.

## 6. Odtworzenie z kopii

Wszystkie urządzenia zgubione, został węzeł:

1. Nowa instalacja → wpisanie frazy → odtworzenie obu kluczy użytkownika.
2. Bilet węzła (zapisany razem z frazą) → połączenie → pobranie `acl_log`.
3. Otwarcie swoich kopert → klucze przestrzeni wszystkich epok, w których użytkownik był uczestnikiem.
4. Pobranie migawki i nowszych wiadomości → odszyfrowanie → pliki `.md` z powrotem na dysku.

Bez frazy kopia na węźle jest bezużyteczna — także dla właściciela serwera.

## 7. Usunięcie uczestnika i epoki

- `Usuń` w dzienniku uczestników tworzy **nową epokę**: nowy losowy klucz przestrzeni, koperta dla każdego pozostałego.
- Od tej chwili wiadomości i migawki są szyfrowane nową epoką; usunięty nie odczyta niczego nowego — także z węzła.
- Stare epoki zostają w kopertach, więc pozostali dalej czytają historię.
- Po zmianie epoki urządzenie właściciela od razu robi nową migawkę: nowy uczestnik dostaje kopertę tylko bieżącej epoki, więc startuje z migawki, nie ze starych wiadomości.

## 8. Plan wdrożenia

**Krok A — format wiadomości już teraz (etap 2, mała zmiana w `core`) — ✅ zrobione** (`crates/core/src/message.rs`; tabela `messages` trzyma `(device, seq, bytes)`, klucz w tabeli `space`). Wcześniej `messages` trzymał jawne `doc` i `payload`, a podpis obejmował tekst jawny. Zmieniamy to od razu na format z §3, z jednym tymczasowym kluczem przestrzeni (epoka 0) trzymanym w `space.db`. Wtedy dziennik od początku ma docelową postać i etapy 3–4 niczego w nim nie przepisują. Zamyka to też skrót „brak id przestrzeni w podpisie”.

**Krok B — tożsamość i uprawnienia (etap 3, nowy crate `sync`).** Fraza → klucze, certyfikaty urządzeń, `acl_log`, koperty, epoki, reguły odrzucania z §3. Klucz epoki 0 z kroku A trafia do pierwszej koperty właściciela. Testowane bez sieci: dwie instancje w jednym procesie wymieniają wiadomości.
**Status (T13b):** ✅ połączone z `core`: `space.db` nie trzyma sekretów (układ `space`/`messages`/`file_state` + publiczne `acl`, `certs`, `acl_head`), `core` dostaje klucze i reguły przez cechę `Access`, odbiór z sieci przez `Space::receive` (te same reguły, granice i kontrola równoważności), odrzucone wiadomości przy otwarciu są pomijane i zgłaszane. Migracja starego pliku: `notes_sync::space::migrate_legacy`. Otwarte: magazyn systemowy w aplikacji Tauri (etap 3), migawki i kopia na węźle (krok C).

**Krok C — węzeł i kopia (etap 4, crate `node`).** `notes-node` z bazą z §4, weryfikacja kroków 1–3, okresowa wysyłka z urządzeń, migawki, załączniki, odtworzenie z §6.

### 8a. Krok B — reguły (ustalone 2026-10-22)

- **Fraza:** BIP39, 24 słowa (lista angielska — standard nie ma polskiej), ziarno = `to_seed("")`. Klucze użytkownika z §2 przez `blake3::derive_key(kontekst, ziarno)`. Sekrety w `Zeroizing`.
- **Certyfikat urządzenia:** `podpis_użytkownika("notes device-cert v1" ‖ klucz użytkownika ‖ klucz urządzenia ‖ czas)`. Nie zależy od przestrzeni — jeden na urządzenie.
- **Dziennik uczestników (`acl_log`):** łańcuch wpisów `{przestrzeń, nr, skrót poprzedniego (BLAKE3), treść}` podpisanych kluczem użytkownika **właściciela** (tylko właściciel pisze — brak rozgałęzień łańcucha; członek prosi właściciela o unieważnienie swojego urządzenia) [skrót: współwłaściciele później]. Wpisy: `Założenie` (właściciel, koperta epoki 0), `Dodaj` (użytkownik, klucz X25519, rola, koperta bieżącej epoki), `Zmień rolę`, `Usuń`, `Unieważnij urządzenie`.
- **Każde odebranie lub obniżenie uprawnień zaczyna nową epokę** (`Usuń`, `Zmień rolę` na niższą, `Unieważnij urządzenie`): wpis niesie koperty nowego klucza dla wszystkich pozostałych uczestników oraz **granice** — dla każdego urządzenia, którego dotyczy, ostatni `seq` znany właścicielowi.
- **Reguła przyjęcia wiadomości** (u uczestnika i na węźle): podpis OK; certyfikat urządzenia podpisany przez uczestnika; urządzenie nieunieważnione **albo** `seq ≤ granica`; autor miał rolę edytora/właściciela **w epoce wiadomości** (w obrębie jednej epoki zbiór piszących tylko rośnie, bo każde odebranie uprawnień zamyka epokę); dla usuniętego / zdegradowanego autora dodatkowo `seq ≤ granica`. Dzięki temu dawne zmiany usuniętej osoby zostają w historii (odtworzenie dziennika daje ten sam tekst), a nowe — także podpisane starym kluczem epoki — są odrzucane. (Zamyka UWAGI pkt 1–2.)
- **Koperta:** sealed box `crypto_box` do klucza X25519 uczestnika z treścią `przestrzeń ‖ epoka ‖ klucz`; przy otwarciu sprawdzane są przestrzeń i epoka.
- **Zaproszenie:** bilet `{przestrzeń, klucz właściciela, sekret 16 B, ważność}` (tekst base32). Zapraszany wysyła prośbę `{klucze użytkownika, certyfikat urządzenia, MAC = blake3_keyed(sekret, klucze ‖ certyfikat)}`. Obie strony pokazują **kod bezpieczeństwa** (6 cyfr z BLAKE3 nad kluczem właściciela, kluczem zapraszanego i sekretem) do porównania; właściciel zatwierdza → wpis `Dodaj`. Sekret jednorazowy.
- **Nowe urządzenie tego samego użytkownika:** fraza → klucze → nowy certyfikat; klucze epok z własnych kopert w `acl_log`. Zgoda właściciela niepotrzebna.
- **Magazyn kluczy:** cecha `KeyStore` (klucze urządzenia, klucze epok); implementacja w pamięci do testów i systemowy magazyn haseł za flagą kompilacji [skrót: podłączenie przy aplikacji Tauri]. `space.db` nie trzyma już sekretów; klucz epoki 0 z kroku A trafia do koperty `Założenia`, sekret urządzenia — do magazynu.

- **Odchylenia przy implementacji (`crates/sync`, przyjęte):** (1) klucz MAC zaproszenia = `derive_key("notes join key v1", sekret)`, bo `keyed_hash` wymaga 32 B, a sekret ma 16 B; (2) granice nie są sprawdzane co do pełnego zbioru urządzeń (później certyfikowane urządzenie nie może unieważnić wpisu) — urządzenie nieobjęte granicą jest odrzucane (domyślna odmowa), a granica obowiązuje tylko dla epok sprzed zmiany; (3) kod bezpieczeństwa liczy się z obu kluczami zapraszanego; (4) weryfikator dziennika nie zna właściciela z góry — wywołujący musi sprawdzić `owner` z biletu.

### 8b. Zgubione urządzenie (poprawka 2026-10-22)

Gdyby urządzenie trzymało frazę lub klucze użytkownika, złodziej otworzyłby koperty nowej epoki adresowane do użytkownika — unieważnienie nic by nie dało. Dlatego:

- **Fraza nie jest przechowywana na żadnym urządzeniu.** Pokazana raz przy założeniu konta; wpisywana tylko przy dodawaniu urządzenia i odzyskiwaniu. Klucze użytkownika istnieją w pamięci tylko na ten czas.
- **Urządzenie ma dwa własne losowe klucze:** Ed25519 (podpisy wiadomości) i X25519 (koperty). Certyfikat urządzenia obejmuje oba: `"notes device-cert v2" ‖ użytkownik ‖ klucz podpisu urządzenia ‖ klucz X25519 urządzenia ‖ czas`.
- **Koperty na dwóch poziomach:** dla każdego uczestnika (do klucza X25519 użytkownika — tylko do odzyskiwania z frazy) oraz dla każdego znanego, nieunieważnionego urządzenia pozostałych uczestników (do klucza X25519 urządzenia, z pełnym certyfikatem, żeby weryfikator sprawdził, czyje to urządzenie). Na co dzień urządzenie otwiera tylko swoje koperty urządzenia. Koperta urządzenia dla unieważnionego urządzenia lub urządzenia usuniętego uczestnika → wpis odrzucony.
- **Nowe urządzenie:** przy konfiguracji (fraza wpisana) otwiera koperty użytkownika wszystkich dotychczasowych epok i zapisuje klucze epok w magazynie; frazę zapomina. Jeśli kolejna rotacja nie zawiera jeszcze jego koperty (właściciel nie znał certyfikatu), aplikacja prosi o ponowne wpisanie frazy.
- **Wpisy dziennika podpisuje właściciel albo jedno z jego urządzeń:** wpis niesie certyfikat podpisującego urządzenia (podpisany kluczem użytkownika właściciela); urządzenie unieważnione wcześniej w łańcuchu nie może już podpisywać. Założenie podpisuje klucz użytkownika właściciela. Dzięki temu zgubione urządzenie właściciela da się unieważnić z innego jego urządzenia [skrót: rozgałęzienie łańcucha przez skradzione urządzenie przed unieważnieniem wykryje węzeł w etapie 4].

**Ograniczenie odzyskiwania [skrót]:** odzyskanie zachowuje klucz urządzenia, który już jest w magazynie kluczy (jeden klucz obsługuje wszystkie przestrzenie na tym komputerze). Jeśli folder go nie zna, klucz dostaje nowy certyfikat podpisany przez użytkownika. Jeśli klucz jest w tej przestrzeni unieważniony albo poświadczony dla innego członka, odzyskanie odmawia (`device_unusable`): nowego klucza tylko dla jednej przestrzeni aplikacja jeszcze nie umie wydać. Nowy certyfikat zostaje tylko w lokalnym magazynie folderu. Dziennik się nie wydłuża, więc nie trafia do rozmówców: węzeł i inne urządzenia przyjmują rozmówcę tylko z certyfikatem, który już znają, i odrzucają to urządzenie ("brak dostępu do przestrzeni"). Do czasu wymiany certyfikatów w `Hello` (certyfikaty niesione przez rozmowę i przyjmowane, gdy spełniają `keeps_cert`) odzyskane urządzenie działa tylko lokalnie. Aplikacja nie ma jeszcze sieci, więc to ograniczenie dotyczy kolejnego etapu.

### 8c. Poprawki po przeglądzie bezpieczeństwa (2026-10-22)

- **Kod bezpieczeństwa zaproszenia z zobowiązaniem** (jak SAS w ZRTP): zapraszany najpierw wysyła `commit = BLAKE3("notes join commit v1" ‖ klucze użytkownika ‖ certyfikat ‖ nonce_z)`, właściciel odpowiada losowym `nonce_w`, dopiero potem zapraszany ujawnia klucze, certyfikat i `nonce_z`. Kod (6 cyfr) = BLAKE3(klucz właściciela ‖ klucze zapraszanego ‖ sekret ‖ `nonce_w` ‖ `nonce_z`). Napastnik z przechwyconym biletem musi zgadnąć kod za jednym podejściem (1 : 10⁶), bo nie zna `nonce_w`, zanim się zobowiąże. API wymusza tę kolejność.
- **Certyfikat urządzenia z dowodem posiadania:** oprócz podpisu użytkownika zawiera podpis kluczem urządzenia nad `"notes device-pop v1" ‖ użytkownik ‖ klucz podpisu urządzenia ‖ klucz X25519 urządzenia ‖ czas`. Nikt nie przypisze sobie cudzego (jawnego) klucza urządzenia.
- **Ochrona przed cofnięciem dziennika uczestników:** urządzenie trwale pamięta najwyższą znaną głowę `(nr, skrót)` i przyjmuje tylko dziennik, który ją zawiera i jest co najmniej tak długi. Docelowo `Hello` niesie głowę; nic nie jest wysyłane do rozmówcy ze starszą głową.
- **Granice wiążą treść:** granica = `(seq, BLAKE3 bajtów wiadomości o tym seq)`; wiadomość o tym samym `seq`, ale innej treści jest odrzucana. Skrót [shortcut]: wiadomości poniżej granicy mogą nadal zostać rozdwojone przez skradzione urządzenie, dopóki wiadomości nie tworzą łańcucha na urządzenie (skrót poprzedniej wiadomości w nagłówku `core`).
- Właściciel nie może usunąć ani zdegradować użytkownika, pomijając w granicach któreś z jego znanych urządzeń.

Podział kodu [decyzja]: format i szyfrowanie wiadomości w `core` (bo zapis lokalny już teraz tworzy wiadomości w `core`); tożsamość, dziennik uczestników i sieć w `sync`; `node` używa weryfikacji z `sync`.

## 9. Testy, które muszą istnieć

- przeszukanie surowych bajtów bazy węzła (i ruchu przez relay) nie znajduje fragmentu treści, nazwy notatki ani id notatki;
- węzeł odrzuca wiadomość od obcego urządzenia, od czytelnika i od usuniętego uczestnika;
- zmiana jednego bajtu nagłówka, szyfrogramu albo podpisu → odrzucenie (u uczestnika i na węźle);
- wiadomość z jednej przestrzeni wklejona do innej → odrzucenie (id przestrzeni w AAD i podpisie);
- po usunięciu uczestnika jego klucze nie odszyfrują nowych wiadomości ani nowej migawki z węzła;
- dwie wiadomości o różnej długości tekstu (w jednym kubełku) mają ten sam rozmiar;
- pełne odtworzenie z samej frazy i biletu węzła daje identyczny tekst wszystkich notatek;
- węzeł podający starszy stan → urządzenie wysyła mu brakujące wiadomości ponownie.
