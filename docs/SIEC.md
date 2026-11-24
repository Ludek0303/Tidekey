# Architektura sieci

Jak urządzenia i węzeł przechowujący się znajdują, łączą i wymieniają zmiany. Uzupełnia [ARCHITEKTURA.md](ARCHITEKTURA.md) §4.8 (protokół) i §4.18 (węzeł). Szczegóły biblioteki iroh oznaczone **[sprawdzić]** trzeba potwierdzić na początku etapu 4 — iroh szybko się zmienia.

---

## 1. Elementy

| Element | Co to jest | Ile | Czy wymagany |
|---|---|---|---|
| **Urządzenie** | aplikacja na komputerze uczestnika | wiele | tak |
| **Węzeł przechowujący** (`notes-node`) | zawsze włączony program na VPS / Raspberry Pi; trzyma zaszyfrowane wiadomości, przekazuje je dalej | zwykle 1 na grupę | nie, ale bez niego zmiany przechodzą tylko między włączonymi komputerami |
| **Relay** | serwer pośredniczący iroh: przekazuje zaszyfrowane pakiety, gdy dwa urządzenia nie mogą połączyć się bezpośrednio; pomaga też w przebijaniu NAT | 1+ | tak, ale może być publiczny (n0) |
| **Wykrywanie (discovery)** | usługa „klucz publiczny → aktualny adres” | — | publiczna n0 albo adresy w biletach |

Najważniejsza zasada: **adresem urządzenia jest jego klucz publiczny**, nie IP ani domena. Połączenie jest uwierzytelniane tym kluczem (QUIC + TLS z kluczami publicznymi zamiast certyfikatów od urzędu certyfikacji). Dlatego zwykłe połączenie nie potrzebuje domeny ani certyfikatu.

## 2. Adres i bilet

Każde urządzenie i węzeł mają **adres iroh**:

```text
NodeAddr = klucz publiczny  +  adres relaya (URL)  +  bezpośrednie adresy IP:port (jeśli znane)
```

- Klucz publiczny jest stały. IP i relay mogą się zmieniać.
- **Bilet** (zaproszenie, bilet węzła) to zakodowany `NodeAddr` + dane przestrzeni — tekst do skopiowania albo kod QR.
- Gdy IP się zmieni (laptop w innej sieci), urządzenie publikuje nowy adres w usłudze wykrywania; inni znajdują je po kluczu. **[sprawdzić]** obecny mechanizm iroh (DNS/pkarr n0, lokalny mDNS).

## 3. Drogi połączenia

**Zasada (decyzja 2026-10-19):** ta sama sieć → bezpośrednio, bez serwera; różne sieci → **przez własny węzeł**, który przy okazji zapisuje zaszyfrowaną kopię.

```text
1. LAN          Ania ◀──────── ta sama sieć (mDNS) ────────▶ Bartek          ~1 ms, serwer niepotrzebny
2. Przez węzeł  Ania ──▶ węzeł (zapisuje + przekazuje) ──▶ Bartek            ~20–100 ms, węzeł widzi tylko szyfrogram
   zapas        gdy węzeł nieosiągalny: bezpośrednio przez przebity NAT albo relay iroh (opis poniżej)
```

Węzeł na VPS ma publiczny adres, więc laptopy łączą się z nim wychodząco — bez przebijania NAT, bez relaya, bez domeny (wariant A w §5). Poniższy opis przebijania NAT i relaya dotyczy drogi zapasowej i węzła stojącego w domu za routerem (wariant B).

Relay jest zawsze potrzebny „w tle”: nawet przy połączeniu bezpośrednim pomaga urządzeniom poznać swoje publiczne adresy i rozpocząć przebijanie NAT.

### 3.1. Przykład: Ania w Krakowie, Bartek w Gdańsku, każde na domowym Wi-Fi

Problem: oba laptopy są za routerami (NAT). Żaden nie ma publicznego adresu, a router **wpuszcza tylko odpowiedzi** na to, co komputer sam wcześniej wysłał. Bezpośrednio „zadzwonić” do Bartka się nie da.

```text
 Kraków                                                       Gdańsk
 laptop Ani ── router A (NAT) ──┐                ┌── router B (NAT) ── laptop Bartka
 192.168.1.10 203.0.113.10:51000│                │198.51.100.20:62000 192.168.0.5
                                ▼                ▼
                             relay (publiczny serwer)
```

1. **Start aplikacji:** każdy laptop sam łączy się *wychodząco* z relayem (wychodzące połączenia routery zawsze przepuszczają). Relay mówi każdemu, jaki ma publiczny adres: Ania = `203.0.113.10:51000`, Bartek = `198.51.100.20:62000`.
2. **Ania chce połączyć się z Bartkiem:** zna jego klucz publiczny (z dziennika uczestników), z usługi wykrywania dowiaduje się, przez który relay jest osiągalny.
3. **Od razu działa przez relay:** pierwsze zaszyfrowane pakiety idą Ania → relay → Bartek. Edycja na żywo działa już w tej sekundzie, choć wolniej.
4. **Przebijanie NAT (w tle):** przez relay wymieniają się publicznymi adresami i w tym samym momencie wysyłają do siebie pakiety UDP. Router Ani widzi pakiet *wychodzący* do `198.51.100.20:62000`, więc pakiet przychodzący z tego adresu uznaje za „odpowiedź” i wpuszcza. Router Bartka — symetrycznie. Powstaje bezpośredni tunel.
5. **Przełączenie:** gdy tunel działa, ruch idzie bezpośrednio Kraków ↔ Gdańsk, relay odpada. Szyfrowanie bez zmian (od początku do końca między laptopami).
6. **Gdy przebicie się nie uda** (niektóre sieci komórkowe, CGNAT u części dostawców, firmowe zapory): zostaje relay. Działa zawsze, tylko z większym opóźnieniem.

Analogia: dwa bloki z portierami, którzy wpuszczają tylko odpowiedzi na wysłane listy. Pośrednik podaje każdemu adres drugiego; oboje wysyłają list jednocześnie, więc każdy portier traktuje list z drugiej strony jak odpowiedź.

**Z węzłem na VPS to wszystko odpada:** węzeł ma publiczny adres, więc oba laptopy łączą się z nim wychodząco i węzeł przekazuje zmiany na żywo w obie strony (§4.1).

## 4. Przepływ zmian

### 4.1. Dwie osoby pracują jednocześnie

```text
a) ta sama sieć                              b) różne sieci
   Ania ◀═══ LAN, na żywo ═══▶ Bartek            Ania ══▶ węzeł ══▶ Bartek   (na żywo)
     ┆                           ┆                         │
     └┄┄▶ węzeł (kopia co 5 min) ◀┘                     zapis kopii
```

1. Ania pisze → co ~300 ms powstaje podpisana, zaszyfrowana wiadomość (SZYFROWANIE §3).
2. **Ta sama sieć:** wiadomość leci prosto po LAN do Bartka, bez serwera. Do węzła idzie okresowo (co 5 minut, przy starcie i przy zamykaniu) jako kopia zapasowa.
3. **Różne sieci:** wiadomość leci od razu do węzła; węzeł sprawdza podpis i rolę, zapisuje ją i natychmiast przekazuje Bartkowi.
4. Przy kilku osobach oba przypadki działają naraz (Ania i Bartek w biurze, Cezary w domu: biuro po LAN, Cezary przez węzeł). Duplikaty są rozpoznawane po `(urządzenie, seq)` i stosowane raz.

### 4.2. Autor się wyłącza, druga osoba włącza się później

1. Ania przy zamykaniu dosyła do węzła wiadomości, których węzeł jeszcze nie potwierdził (limit kilku sekund).
2. Bartek po starcie łączy się z węzłem, wymienia wektory wersji, pobiera brakujące.

### 4.3. Nowe urządzenie / długa nieobecność

Pobiera zaszyfrowaną migawkę stanu przestrzeni z węzła (albo od dowolnego uczestnika), potem wiadomości nowsze od migawki.

## 5. Czy potrzebna jest domena?

**Krótko: sam węzeł — nie. Własny relay — praktycznie tak (darmowa subdomena wystarczy).**

| Wariant | Domena | Co trzeba |
|---|---|---|
| **A. Węzeł na VPS ze stałym IP**, relaye publiczne n0 | **nie** | otwarty jeden port UDP; bilet węzła zawiera IP:port |
| **B. Węzeł w domu (Raspberry Pi) za routerem**, relaye n0 | **nie** | nic — węzeł łączy się przez relay n0 i przebija NAT; adres znajdowany po kluczu |
| **C. Węzeł + własny relay** (`notes-node --relay`) | **tak** | domena lub darmowa subdomena (np. DuckDNS) + certyfikat Let's Encrypt (wydawany automatycznie) |

Dlaczego tak:
- **Połączenia między urządzeniami i z węzłem** są uwierzytelniane kluczem publicznym, nie certyfikatem dla domeny. Wystarczy IP (wariant A) albo relay, który pomoże się znaleźć (wariant B).
- **Relay** działa przez HTTPS (także jako awaryjna droga przez TCP 443, gdy UDP jest zablokowane). Aplikacje sprawdzają jego certyfikat jak przeglądarka, a darmowy certyfikat Let's Encrypt wydaje się dla nazwy domenowej, nie dla gołego IP. **[sprawdzić]** czy obecny `iroh-relay` dopuszcza inny sposób (np. przypięty certyfikat) — jeśli tak, wariant C też obejdzie się bez domeny.

**Rekomendacja na start:** wariant A albo B — zero domen, zero certyfikatów. Własny relay (C) dopiero, gdy chcecie całkowitej niezależności od serwerów n0.

## 6. Porty i zapora

| Kto | Port | Po co |
|---|---|---|
| Urządzenie | wychodzące UDP i TCP 443 | zwykle nic nie trzeba otwierać |
| Węzeł (A) | **przychodzący UDP**, stały numer (np. 7842 — [decyzja]) | połączenia bezpośrednie od urządzeń |
| Węzeł (B) | nic | ruch przez relay / przebity NAT |
| Relay (C) | TCP 80 (Let's Encrypt), TCP 443 (relay), UDP 3478 (odkrywanie adresów publicznych) | **[sprawdzić]** dokładną listę dla bieżącej wersji iroh-relay |

## 7. Kto co widzi

| Kto | Treść notatek | Nazwy notatek | Kto jest w przestrzeni | Kiedy i ile się pisze | IP uczestników |
|---|---|---|---|---|---|
| Uczestnik (edytor/czytelnik) | ✅ | ✅ | ✅ | ✅ | ✅ (połączonych z nim) |
| Węzeł przechowujący | ❌ | ❌ | ✅ klucze publiczne | ✅ | ✅ |
| Relay (n0 albo własny) | ❌ | ❌ | ❌ | ✅ rozmiar i czas pakietów | ✅ |
| Dostawca internetu | ❌ | ❌ | ❌ | ✅ | ✅ |

Wniosek: relay n0 nie widzi treści ani składu przestrzeni, ale widzi, że dane IP ze sobą rozmawiają. Kto tego nie chce — wariant C.

## 8. Co, gdy coś nie działa

| Awaria | Skutek | Co robi aplikacja |
|---|---|---|
| Brak internetu | praca lokalna | zmiany czekają w dzienniku; pasek „Offline — X zmian czeka” |
| Węzeł wyłączony | brak kopii i dostarczania do osób offline | LAN działa dalej; różne sieci przechodzą na zapas (bezpośrednio / relay); węzeł nadrobi po powrocie |
| Relay n0 niedostępny | brak połączeń przez NAT | LAN i węzeł ze stałym IP (A) działają dalej; ratunek: własny relay (C) |
| Zablokowane UDP (firma) | brak połączeń bezpośrednich | relay przez TCP 443 |
| Złośliwy węzeł lub relay | może wstrzymać dostarczanie | nie odczyta i nie podrobi danych; bezpośrednia synchronizacja omija go |

## 9. Wdrożenie węzła (wariant A — VPS)

```bash
# na serwerze
notes-node init --data /var/lib/notes-node --port 7842   # wypisuje bilet węzła
systemctl enable --now notes-node
# w aplikacji: Ustawienia przestrzeni → Dodaj węzeł → wklej bilet
```

To docelowy kształt poleceń (etap 4), nie istniejący jeszcze program.
