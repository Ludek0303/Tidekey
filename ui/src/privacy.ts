// The public pages without the app: the privacy policy at /prywatnosc (art. 13 RODO), the terms at /regulamin and
// the help at /pomoc, and the first-visit notice about cookies. Both describe what the
// code really stores: keep them in step with auth.rs (cookie, retention), vaults.rs (tables) and the localStorage keys.
import { el } from "./dom";
import { OPERATOR, PRIVACY_VERSION, field, missingOperatorFields } from "./legal";

export const PRIVACY_PATH = "/prywatnosc";
export const TERMS_PATH = "/regulamin";
export const HELP_PATH = "/pomoc";
const NOTICE_KEY = "notes.cookies.v1";

type Block = string | string[]; // a paragraph, or a list
type Section = [id: string, title: string, blocks: Block[]];
const PRIVACY: Section[] = [
  ["administrator", "1. Administrator danych", [
    `Administratorem danych kont w serwisie ${OPERATOR.domain} jest: ${field("name")}, ${field("address")}. Kontakt w sprawach danych osobowych: ${field("email")}.`,
    OPERATOR.dpo ? `Inspektor ochrony danych: ${OPERATOR.dpo}.` : "Inspektor ochrony danych: (do uzupełnienia przez administratora: dane inspektora albo informacja, że nie został wyznaczony).",
    `Treść organizacji (notatki, zadania, kalendarze) dodają i udostępniają jej członkowie. Kto decyduje o tej treści i w jakiej roli wobec niej jest administrator serwisu: ${field("organizationRoles")}.`,
  ]],
  ["dane", "2. Jakie dane przetwarzamy", [
    [
      "Konto: adres e-mail (logowanie i kontakt w sprawie konta), imię lub nazwa wyświetlana (wymagane; może to być pseudonim), nazwisko (opcjonalne, w zaszyfrowanej postaci), skrót hasła (Argon2id; samego hasła nie przechowujemy), data założenia konta.",
      "Ustawienia wyglądu i edytora (motyw, kolor akcentu, rozmiar czcionki i inne; bez ustawień tego urządzenia): zapisane na koncie w postaci zaszyfrowanej w Twojej przeglądarce, więc serwer ich nie odczyta.",
      "Sesja: skrót losowego identyfikatora sesji z datą utworzenia i wygaśnięcia (plik cookie, sekcja 8).",
      "Ochrona logowania: licznik nieudanych logowań dla pary „adres e-mail + pseudonim adresu IP” (15 minut) i licznik nowych kont dla pseudonimu adresu IP (godzina, tylko w pamięci serwera).",
      "Współdzielone sejfy: nazwa i rodzaj sejfu (czytelne dla serwera), lista członków z rolami i datą dołączenia, zaproszenia (kto i kiedy je utworzył, z jaką rolą, kiedy wygasają i czy zostały użyte), klucze publiczne oraz zaszyfrowane kopie kluczy.",
      "Treść: notatki, zadania, kalendarze, historia zmian i kosz trafiają na serwer zaszyfrowane w Twojej przeglądarce (AES-256-GCM). Serwer nie ma klucza i nie może ich odczytać, ale widzi ich rozmiar, czas zapisu oraz to, które konto i do którego sejfu je zapisało.",
      "Pliki (załączniki): treść, nazwa, typ pliku i miniatury zdjęć są szyfrowane w Twojej przeglądarce (XChaCha20-Poly1305, osobny losowy klucz dla każdego pliku; klucz pliku jest zaszyfrowany kluczem sejfu albo chronionego projektu). Serwer przechowuje je w magazynie plików na tym samym serwerze i nie może ich odczytać, ale widzi rozmiar zaszyfrowanego pliku (z którego wynika rozmiar oryginału), czas przesłania, konto, które go przesłało, sejf, stan (przesyłany, gotowy, w koszu), to, czy należy do chronionego projektu, oraz to, który plik jest miniaturą którego zdjęcia. Serwer nie wie, w których notatkach plik jest użyty.",
      "Dziennik zdarzeń bezpieczeństwa: logowania (także nieudane), założenie i usunięcie konta, zmiana hasła, zmiany członków, ról i kluczy w sejfach, z identyfikatorem konta i sejfu. Bez adresu e-mail, adresu IP i haseł.",
    ],
    "Serwer nie zapisuje adresu IP. Na potrzeby limitów liczy z niego skrót z tajnym kluczem losowanym przy każdym uruchomieniu serwera i nigdzie niezapisywanym. To pseudonimizacja, a nie anonimizacja: taki skrót nadal jest daną osobową, dlatego trzymamy go tylko tak krótko, jak wyżej. Pełny adres IP widzi dostawca połączenia (sekcja 4).",
    "Nie zbieramy daty urodzenia, numeru telefonu ani adresu zamieszkania.",
  ]],
  ["cele", "3. Cele, podstawy prawne i pola wymagane", [
    [
      "Założenie i prowadzenie konta, logowanie, synchronizacja i współdzielenie sejfów: wykonanie umowy o świadczenie usługi (art. 6 ust. 1 lit. b RODO). Do tego potrzebne są: adres e-mail, hasło oraz imię lub nazwa wyświetlana, po której inni członkowie rozpoznają Cię w organizacji.",
      "Nazwisko jest dobrowolne. Podajesz je tylko, jeśli chcesz, by członkowie Twoich organizacji widzieli je obok nazwy. Możesz je w każdej chwili zmienić albo usunąć. Brak nazwiska nie ogranicza żadnej funkcji.",
      "Ochrona przed przejęciem konta i nadużyciami (limity prób logowania i zakładania kont, dziennik zdarzeń bezpieczeństwa): prawnie uzasadniony interes administratora (art. 6 ust. 1 lit. f RODO) — bezpieczeństwo serwisu i jego użytkowników. Możesz wnieść sprzeciw (sekcja 7).",
    ],
    "Akceptacja regulaminu przy rejestracji jest zawarciem umowy, a nie zgodą na przetwarzanie danych. Nie prosimy o zgodę, bo nie przetwarzamy danych w celach, które by jej wymagały (bez reklam, analityki i profilowania). Nie podejmujemy decyzji w sposób zautomatyzowany.",
  ]],
  ["odbiorcy", "4. Odbiorcy i widoczność danych", [
    [
      `Połączenie z serwisem obsługuje Cloudflare, Inc. (HTTPS, ochrona przed atakami). Cloudflare widzi adres IP, pliki cookie i przesyłane dane; treść notatek jest już wtedy zaszyfrowana, ale adres e-mail, nazwa i hasło przy logowaniu oraz nazwy sejfów przechodzą przez Cloudflare w postaci czytelnej dla tego dostawcy. Dane mogą trafiać poza Europejski Obszar Gospodarczy. Podstawa przekazania: ${field("transferBasis")}.`,
      "Członkowie wspólnej organizacji (sejfu) widzą Twoje imię lub nazwę wyświetlaną, nazwisko (jeśli je podasz), rolę i Twoje zmiany w tym sejfie.",
      "Adres e-mail widzą tylko właściciele i administratorzy sejfu, do którego należysz (do zarządzania członkami), oraz Ty. Pozostali członkowie go nie widzą.",
      "Nie ma publicznego katalogu użytkowników ani wyszukiwarki kont. Osoby spoza Twoich sejfów nie widzą Twoich danych.",
    ],
  ]],
  ["okres", "5. Jak długo przechowujemy dane", [
    [
      "Konto (e-mail, nazwa, nazwisko, skrót hasła): do usunięcia konta.",
      "Sesja logowania: do wylogowania, najdłużej 30 dni.",
      "Licznik nieudanych logowań: 15 minut. Licznik nowych kont: godzina, tylko w pamięci.",
      "Zaproszenia: link działa 7 dni; zapis o zaproszeniu zostaje do usunięcia sejfu.",
      "Dziennik zdarzeń bezpieczeństwa: do wyczerpania limitu dziennika serwera (5 plików po 10 MB), potem najstarsze wpisy są nadpisywane.",
      `Kopie zapasowe danych serwera: ${field("backups")}.`,
      "Kosz i historia wersji notatek są częścią zaszyfrowanego sejfu: zostają, dopóki członkowie ich nie usuną albo nie zostanie usunięty sejf.",
      "Pliki: do usunięcia z kosza (z kosza są usuwane automatycznie po 30 dniach, wcześniej może je usunąć administrator sejfu) albo do usunięcia sejfu. Usunięcie odnośnika w notatce nie usuwa pliku. Nieukończone przesyłanie jest usuwane po 24 godzinach.",
    ],
  ]],
  ["usuwanie", "6. Usunięcie konta", [
    "Konto usuniesz w Ustawieniach → Konto. Usuwane są: dane konta, sesje, Twoje klucze na serwerze, Twój osobisty sejf i sejfy, w których byłeś jedynym członkiem, oraz Twoje członkostwa.",
    "Treść dodana do wspólnej organizacji zostaje w niej dla pozostałych członków, razem z historią zmian. Twoja nazwa może pozostać w tej treści (np. jako autor wpisu albo @wzmianka w zadaniu), a pozostali członkowie mogą mieć jej kopie na swoich urządzeniach. Serwer nie może jej zmienić, bo nie zna klucza. Zastąpienie nazwy napisem „Usunięty użytkownik” nie oznacza anonimizacji, jeśli treść nadal pozwala Cię rozpoznać — w takiej sprawie napisz do administratora i do właściciela organizacji.",
    "Kopie zapasowe nie są edytowane: usunięte dane znikają z nich wraz z ich wygaśnięciem (sekcja 5).",
    "Jeśli założyłeś organizację, w której są jeszcze inne osoby, albo jesteś jej jedynym właścicielem, usunięcie konta jest wstrzymane, żeby organizacja nie straciła klucza ani właściciela. Jedyny właściciel może przekazać tę rolę innej osobie; założyciel musi najpierw usunąć pozostałych członków (rola założyciela nie przechodzi na innych). Możesz też złożyć żądanie usunięcia danych na adres z sekcji 1 — ograniczenie techniczne nie jest odmową realizacji Twojego prawa.",
  ]],
  ["prawa", "7. Twoje prawa", [
    [
      "Dostęp do danych i kopia: Ustawienia → Konto → „Pobierz moje dane” (plik JSON z danymi konta, sesjami bez identyfikatorów, członkostwami i utworzonymi zaproszeniami; bez haseł, kluczy i danych innych osób) oraz „Pobierz notatki tego sejfu” (treść notatek otwartego sejfu w Markdown, odszyfrowana na Twoim urządzeniu).",
      "Sprostowanie: nazwę i nazwisko zmienisz w Ustawieniach → Konto; nazwisko możesz tam też usunąć.",
      "Usunięcie danych: sekcja 6.",
      "Ograniczenie przetwarzania, przenoszenie danych, sprzeciw wobec przetwarzania opartego na uzasadnionym interesie: napisz na adres z sekcji 1.",
    ],
    "Odpowiadamy bez zbędnej zwłoki, co do zasady w ciągu miesiąca. Możemy poprosić o potwierdzenie, że żądanie pochodzi od właściciela konta (np. wiadomością z adresu e-mail konta).",
    "Masz prawo wnieść skargę do Prezesa Urzędu Ochrony Danych Osobowych (ul. Stawki 2, 00-193 Warszawa, uodo.gov.pl).",
    "Klucz szyfrujący znasz tylko Ty, a kod odzyskiwania jest jego jedyną kopią poza przeglądarką. Administrator nie przywróci treści po utracie tego kodu.",
  ]],
  ["cookies", "8. Pliki cookie, pamięć przeglądarki i wylogowanie", [
    "Używamy wyłącznie mechanizmów niezbędnych do działania serwisu. Nie ma reklam, analityki ani plików cookie firm trzecich, dlatego nie prosimy o zgodę, a jedynie informujemy.",
    [
      "notes_session: plik cookie sesji logowania. HttpOnly, wysyłany tylko do tego serwisu, ważny do 30 dni albo do wylogowania.",
      "IndexedDB „notes-browser-local-v1”: zaszyfrowana kopia Twoich sejfów (działa bez połączenia; bez treści plików — pliki są pobierane z serwera dopiero przy otwarciu i trzymane tylko w pamięci karty do jej zamknięcia), Twój osobisty klucz zapisany jako nieeksportowalny klucz WebCrypto (skrypty nie mogą go odczytać ani wysłać, ale ktoś z dostępem do tego profilu przeglądarki może go użyć przez aplikację) oraz klucze sejfów i projektów zaszyfrowane tym kluczem.",
      "localStorage: ustawienia aplikacji i grafu, ostatnio otwarty sejf, przeczytane powiadomienia, pokazane przypomnienia z kalendarza i informacja o zamknięciu tej wiadomości.",
      "sessionStorage: notatka do otwarcia po przełączeniu sejfu. Znika po zamknięciu karty.",
      "Pamięć plików przeglądarki (OPFS) „voice-models”: model rozpoznawania mowy, pobierany z tego serwisu za Twoją zgodą przy pierwszym dyktowaniu. Nagrań głosu nie zapisujemy nigdzie: dźwięk z mikrofonu jest rozpoznawany w pamięci karty i usuwany po przepisaniu fragmentu, a do notatki trafia tylko tekst (szyfrowany jak przy pisaniu z klawiatury). Model usuniesz w Ustawieniach → Dyktowanie.",
      "Cloudflare może ustawić techniczne pliki cookie ochrony przed botami (np. __cf_bm).",
    ],
    "„Wyloguj” kończy sesję i usuwa plik cookie, ale zostawia na tym urządzeniu zaszyfrowaną kopię i klucz, żeby kolejne logowanie nie wymagało kodu odzyskiwania. „Wyloguj i usuń dane z tego urządzenia” usuwa też kopię i klucze tego konta z przeglądarki — używaj go na wspólnych komputerach. Dane innych osób zalogowanych w tej przeglądarce zostają.",
  ]],
  ["wiek", "9. Wiek", ["Serwis jest przeznaczony dla osób, które ukończyły 16 lat."]],
  ["zmiany", "10. Zmiany polityki", [`Wersja z dnia ${PRIVACY_VERSION}. O istotnych zmianach poinformujemy w serwisie.`]],
];

const TERMS: Section[] = [
  ["uslugodawca", "1. Usługodawca", [
    `Serwis Notatki pod adresem ${OPERATOR.domain} prowadzi ${field("name")}, ${field("address")}, e-mail: ${field("email")}.`,
  ]],
  ["usluga", "2. Usługa", [
    "Serwis pozwala zapisywać notatki, zadania i kalendarze, szyfrowane w przeglądarce, oraz współdzielić je z innymi osobami w sejfach organizacji. Usługa jest bezpłatna.",
    "Do korzystania potrzebna jest aktualna przeglądarka z włączoną obsługą JavaScript i pamięci lokalnej oraz połączenie z internetem przy synchronizacji.",
  ]],
  ["konto", "3. Konto", [
    "Umowa o świadczenie usługi zostaje zawarta z chwilą założenia konta i akceptacji regulaminu. Konto może założyć osoba, która ukończyła 16 lat.",
    [
      "Podajesz adres e-mail, do którego masz dostęp, oraz imię lub nazwę wyświetlaną, po której rozpoznają Cię członkowie Twoich organizacji. Nazwa nie musi być imieniem z dokumentu, ale nie może wprowadzać innych w błąd co do tego, kim jesteś (np. podszywanie się pod inną osobę).",
      "Nazwisko jest opcjonalne.",
      "Chronisz hasło i kod odzyskiwania. Kod odzyskiwania jest jedynym sposobem odczytania notatek na nowym urządzeniu. Usługodawca go nie zna i nie odtworzy.",
      "Możesz w każdej chwili usunąć konto w Ustawieniach → Konto, co rozwiązuje umowę (zasady w polityce prywatności, sekcja 6).",
    ],
  ]],
  ["zasady", "4. Zasady korzystania", [
    "Nie wolno używać serwisu do treści bezprawnych, do naruszania praw innych osób, do rozsyłania spamu ani do zakłócania działania serwisu (np. przez automatyczne zakładanie kont).",
    "Za treść w sejfie odpowiadają osoby, które ją dodały. Usługodawca nie zna treści notatek, bo są szyfrowane. Zgłoszenia naruszeń przyjmuje na adres z punktu 1.",
    "Usługodawca może usunąć konto, które łamie regulamin, w szczególności konto tworzone automatycznie, po wcześniejszej informacji, chyba że naruszenie jest oczywiste.",
  ]],
  ["odpowiedzialnosc", "5. Dostępność i odpowiedzialność", [
    "Usługodawca dba o działanie serwisu, ale nie gwarantuje ciągłej dostępności. Prace techniczne mogą chwilowo przerwać działanie.",
    "Usługodawca nie odpowiada za utratę dostępu do notatek wynikającą z utraty kodu odzyskiwania ani za skutki udostępnienia linku zaproszenia osobom trzecim. Nie wyłącza to odpowiedzialności wobec konsumentów w zakresie, w jakim przepisy na to nie pozwalają.",
  ]],
  ["reklamacje", "6. Reklamacje", [
    "Reklamacje i pytania wyślij na adres z punktu 1. Odpowiemy w ciągu 14 dni.",
  ]],
  ["dane", "7. Dane osobowe", [
    "Informacje o przetwarzaniu danych są w polityce prywatności. Akceptacja regulaminu nie jest zgodą na przetwarzanie danych.",
  ]],
  ["zmiany", "8. Zmiany regulaminu i prawo", [
    `Wersja z dnia ${PRIVACY_VERSION}. O zmianach poinformujemy w serwisie co najmniej 14 dni wcześniej. Jeśli się nie zgadzasz, możesz usunąć konto.`,
    "W sprawach nieuregulowanych stosuje się prawo polskie. Nie ogranicza to praw konsumenta wynikających z przepisów jego kraju.",
  ]],
];

const HELP: Section[] = [
  ["kod", "Kod odzyskiwania: zapisz go!", [
    "Przy zakładaniu konta dostajesz kod odzyskiwania (64 znaki). Tylko on odszyfrowuje Twoje notatki. Serwer go nie zna, więc nikt, także administrator, nie odzyska Twoich notatek, jeśli go zgubisz.",
    [
      "Zapisz kod w menedżerze haseł albo wydrukuj i schowaj.",
      "Na nowym urządzeniu albo po wyczyszczeniu danych przeglądarki logujesz się hasłem, a potem wpisujesz kod.",
      "Hasło możesz zmienić albo odzyskać; kodu nie.",
    ],
  ]],
  ["haslo", "Hasło", [
    "Hasło zmienisz w Ustawieniach → Konto. Inne urządzenia zostaną wtedy wylogowane.",
    `Nie pamiętasz hasła? Napisz do administratora (${field("email")}). Ustawi hasło tymczasowe, które po zalogowaniu zmienisz. Notatki pozostaną nietknięte, bo zależą od kodu odzyskiwania, nie od hasła.`,
  ]],
  ["organizacje", "Organizacje i zaproszenia", [
    [
      "Nową organizację utworzysz z menu pod nazwą przestrzeni (lewy dolny róg) → „Nowa organizacja…”.",
      "Zaproszenie: „Członkowie i zaproszenia…” → wybierz rolę → „Utwórz link”. Link zawiera klucz sejfu, więc wysyłaj go tylko tej osobie. Działa raz i wygasa po 7 dniach.",
      "Role: czytelnik (tylko odczyt), edytor (edycja), administrator (zaprasza i zarządza członkami), właściciel (wszystko).",
      "Po usunięciu kogoś z organizacji klucz sejfu zmienia się automatycznie.",
      "Konto założone z linku zaproszenia otwiera od razu organizację, bez „Moich notatek”. Własne notatki włącza administrator serwera: Ustawienia → Konto → „Poproś o własne notatki”.",
    ],
  ]],
  ["projekty", "Chronione projekty", [
    "Projekt w organizacji można ograniczyć do wybranych osób: Projekty → „Chroń projekt”. Pozostali członkowie widzą tylko kłódkę i nie mogą odczytać jego notatek.",
  ]],
  ["zadania", "Zadania i grupy", [
    "Zadanie to linia listy „- [ ] …” w notatce projektu. Osobę przypiszesz przez @nazwa (nazwa wyświetlana), termin przez 📅 data, a grupę w panelu zadania („Grupa wykonawców”). Grupy tworzysz w „Osoby i grupy”.",
    "Podzadanie to zadanie wcięte pod innym (Tab albo „Dodaj podzadanie” w panelu zadania). Zadania nadrzędnego nie odhaczysz, dopóki jego podzadania nie są zrobione.",
  ]],
  ["claude", "Claude w Notatkach", [
    "Claude (Claude Code albo Claude Desktop) może czytać Twoje notatki i zadania i proponować zmiany. Działa jako osobne urządzenie z własnymi kluczami: nie zna hasła ani kodu odzyskiwania. Kodu odzyskiwania i hasła nigdy nie wpisujesz w Claude.",
    [
      "Połączenie: Ustawienia → Urządzenia → „Połącz Claude” → „Rozpocznij parowanie”. Kod z ekranu wpisujesz tylko w Claude na swoim komputerze, nigdy w rozmowie i nigdy komuś innemu.",
      "Przeglądarka pokaże, kto się łączy, i kod kontrolny: musi być taki sam jak w Claude. Potem wybierasz, co Claude widzi (na starcie nic), tryb zapisu i długość sesji.",
      "Tryby: tylko odczyt (domyślnie), propozycje do zatwierdzenia (Urządzenia → „Propozycje Claude”), dopisywanie, zmiany bezpośrednie (cofniesz je przyciskiem „Cofnij zmiany czatu”).",
      "Sesja wygasa po wybranym czasie albo po godzinie bezczynności: „Przedłuż” w Urządzeniach. Czat z nowego adresu IP czeka na „Potwierdź”.",
      "W organizacji czaty włącza właściciel (Członkowie i zaproszenia… → Czaty Claude).",
      "To, co Claude przeczyta, trafia do rozmowy z Claude (do Anthropic): udostępniaj tylko potrzebne foldery. Link do parowania od kogoś innego to oszustwo. Czat odłączysz w każdej chwili przyciskiem „Odłącz”.",
    ],
  ]],
  ["prywatnosc", "Co widzi serwer", [
    "Serwer przechowuje notatki tylko zaszyfrowane. Widzi adres e-mail, nazwę wyświetlaną, nazwy sejfów, członków i ich role. Nazwiska nie zna: jest zaszyfrowane kluczem konta i kluczem sejfu. Szczegóły są w polityce prywatności.",
  ]],
];

const PAGES: Record<string, { title: string; sections: Section[] }> = {
  [PRIVACY_PATH]: { title: "Polityka prywatności", sections: PRIVACY },
  [TERMS_PATH]: { title: "Regulamin", sections: TERMS },
  [HELP_PATH]: { title: "Pomoc", sections: HELP },
};

/** The page for a path (/prywatnosc, /regulamin, /pomoc), or null for the app's own paths. */
export function publicPage(path: string): string | null {
  const clean = path.replace(/\/+$/, "");
  return clean in PAGES ? clean : null;
}

/** One of the public pages, rendered into `root` without the app. */
export function renderPage(root: HTMLElement, path: string): void {
  const { title, sections } = PAGES[path];
  document.title = `${title} — Notatki`;
  const page = el("main", "legal-page");
  page.append(el("p", "web-auth-eyebrow", "NOTATKI"), el("h1", "", title));
  // The privacy policy and the terms stay marked as drafts until the operator has filled in what only they know.
  const missing = path === HELP_PATH ? [] : missingOperatorFields();
  if (missing.length) {
    const draft = el("div", "legal-draft");
    draft.setAttribute("role", "note");
    draft.append(el("strong", "", "Dokument roboczy. "), document.createTextNode(`Administrator serwisu nie uzupełnił jeszcze: ${missing.join(", ")}. Do tego czasu ten dokument nie jest pełną informacją prawną.`));
    page.append(draft);
  }
  for (const [id, heading, blocks] of sections) {
    const section = el("section");
    section.id = id;
    section.append(el("h2", "", heading));
    for (const block of blocks) {
      if (typeof block === "string") section.append(el("p", "", block));
      else { const list = el("ul"); for (const item of block) list.append(el("li", "", item)); section.append(list); }
    }
    page.append(section);
  }
  const links = el("nav", "legal-links");
  for (const [href, label] of [["/", "Wróć do aplikacji"], [HELP_PATH, "Pomoc"], [TERMS_PATH, "Regulamin"], [PRIVACY_PATH, "Polityka prywatności"]]) {
    if (href === path) continue;
    const a = el("a", href === "/" ? "btn" : "", label);
    a.href = href;
    links.append(a);
  }
  page.append(links);
  root.replaceChildren(page);
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

/** The privacy policy page (kept for callers that render it directly). */
export const renderPrivacy = (root: HTMLElement): void => renderPage(root, PRIVACY_PATH);

/** The first-visit notice: informational only (nothing optional to switch on), remembered once closed. */
export function showCookieNotice(): void {
  try { if (localStorage.getItem(NOTICE_KEY)) return; } catch { /* storage blocked: shown on every visit */ }
  const box = el("aside", "cookie-notice");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Pliki cookie");
  const text = el("p", "", "Używamy tylko niezbędnego pliku cookie sesji i pamięci przeglądarki: do logowania i zaszyfrowanej kopii notatek na tym urządzeniu. Bez reklam i analityki. ");
  const more = el("a", "", "Szczegóły w polityce prywatności");
  more.href = `${PRIVACY_PATH}#cookies`;
  text.append(more);
  const ok = el("button", "btn btn-primary", "Rozumiem");
  ok.type = "button";
  ok.addEventListener("click", () => {
    try { localStorage.setItem(NOTICE_KEY, PRIVACY_VERSION); } catch { /* not remembered */ }
    box.remove();
  });
  box.append(text, ok);
  document.body.append(box);
}
