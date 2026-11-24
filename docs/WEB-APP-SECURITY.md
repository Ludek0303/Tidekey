# Bezpieczeństwo webowego konta i vaultu

## Rozdzielenie pojęć

- **Konto webowe** (e-mail + hasło) uwierzytelnia użytkownika wobec serwera i ogranicza dostęp do jego synchronizacji.
- **Klucz vaultu** odblokowuje treść notatek. Nie jest hasłem do konta, nie trafia do API i nie jest przechowywany w sesji serwera.
- Reset hasła nie może po cichu odszyfrować ani odtworzyć klucza vaultu. Odzyskanie danych na nowym urządzeniu wymaga osobnego sekretu odzyskiwania.

## Synchronizacja webowa

Serwer może przechowywać tylko wersjonowany, uwierzytelniony szyfrogram. Interfejs musi szyfrować dane lokalnie przed wysłaniem i odszyfrowywać po pobraniu. Unikalny nonce jest wymagany dla każdej operacji szyfrującej; identyfikator konta i vaultu powinien być powiązany z szyfrogramem jako dodatkowe uwierzytelnione dane.

Nie wolno umieszczać treści notatek, nazw plików, podglądów, klucza vaultu ani frazy odzyskiwania w logach serwera. Baza kont może zawierać e-mail, weryfikator hasła, skróty tokenów sesji i niezbędne metadane; magazyn synchronizacji ma zawierać wyłącznie szyfrogramy.

## Ramka podglądu plików

Pliki w sejfie mogą pochodzić od współautora, więc każdy plik jest niezaufany: jego parser (pdf.js, biblioteki Office,
3D, własne parsery WASM) może mieć błąd, a złośliwy plik może próbować go wykorzystać. Dlatego plik nigdy nie jest
parsowany ani rysowany w dokumencie aplikacji (tam są klucze), tylko w ramce `/preview/` ([PODGLAD-PLAN.md](PODGLAD-PLAN.md) §2–§4):

- `<iframe sandbox="allow-scripts">` bez `allow-same-origin` i `sandbox allow-scripts` w CSP strony ramki: pochodzenie
  `null`, więc brak dostępu do IndexedDB (klucz osobisty), `localStorage`, ciasteczek i dokumentu aplikacji; bez
  nawigacji okna, bez nowych okien, bez formularzy.
- CSP ramki: `default-src 'none'`, skrypty i style tylko z `/preview/` własnego serwera (`'wasm-unsafe-eval'`, bez
  `eval`), obrazy i media z `blob:`/`data:`, `connect-src blob:` (żaden serwer, także własny, nie jest osiągalny),
  `frame-ancestors 'self'`, bez `report-uri`/`report-to` (raport byłby drogą wyjścia).
- Do ramki trafiają tylko bajty, nazwa, typ, rozmiar i motyw. Nigdy `fileId`, `vaultId`, klucz ani token. Komunikaty są
  sprawdzane po obu stronach (źródło, kształt, rozmiar). Linki w dokumentach nie nawigują ramki.
- Każdy plik dostaje nową ramkę: kod uruchomiony przez plik A nie widzi bajtów pliku B. Zamknięcie okna usuwa ramkę z
  całą jej pamięcią.
- Ramka może tylko wysłać wiadomość do aplikacji; aplikacja przyjmuje z niej wyłącznie zdarzenia okna (następny plik,
  zamknij, pobierz), prośby o pliki `.wasm` z `/preview/assets/` (wzór ścieżki) i surowe piksele miniatury, które sama
  koduje do JPEG (nie parsuje obrazów z ramki).
- Ryzyko szczątkowe: błąd przeglądarki pozwalający uciec z piaskownicy; złośliwy plik może pokazać fałszywą treść w
  oknie podglądu (pasek okna z nazwą pliku rysuje aplikacja, nie ramka).

## Zakres pierwszego wdrożenia

- Wersja webowa i synchronizacja między przeglądarkami jednego konta.
- Osobny vault/klucz na użytkownika; udostępnianie vaultu innym kontom i grupom wymaga odrębnego projektu dystrybucji kluczy.
- Praca lokalna pozostaje dostępna po utracie połączenia. Sesja logowania i lokalny klucz nie mogą być uznane za równoważne.
- Lokalny prototyp oparty na `MockBridge` nie jest źródłem prawdy ani bezpiecznym magazynem produkcyjnym.

## Bramka wydania

Nie ogłaszać obsługi poufnych vaultów ani współdzielenia organizacyjnego, dopóki testy nie potwierdzą: treść jest nieczytelna w bazie serwera, złe hasło/fraza nie odblokowują vaultu, każda operacja szyfrująca ma świeży nonce, a aktualizacja danych z innego urządzenia jest weryfikowana i scala się bez utraty Yjs state.
