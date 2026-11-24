//! Evaluation set for search: a synthetic Polish corpus (notes and OCR text layers, some with OCR errors) and 50
//! queries with the expected documents or chunks. Prints recall@10 and MRR; asserts recall@10 >= 0.9.
//! Recall@10 counts a query as found when one of its expected ids is in the top 10. MRR averages 1/rank of the
//! first expected hit (0 when it is not in the top 10).

use super::SearchIndex;

const NOTES: &[(&str, &str, &str)] = &[
    ("n01", "Projekty/Triton/Triton.md", "---\ntyp: projekt\ntags: [projekt, triton]\n---\n# Triton\nProjekt wdrożenia nowego systemu magazynowego.\n## Koszty\nBudżet projektu wynosi 180 tysięcy złotych. Serwer dedykowany kosztuje 4200 zł miesięcznie.\n## Harmonogram\nWdrożenie w trzecim kwartale, odbiór końcowy w listopadzie.\n"),
    ("n02", "Projekty/Żółw/Żółw.md", "---\ntags: [projekt, zwierzeta]\n---\n# Żółw\nOpieka nad żółwiem lądowym Gustawem. Karmienie sałatą i warzywami dwa razy dziennie.\n## Terrarium\nLampa UVB wymaga wymiany co sześć miesięcy.\n"),
    ("n03", "Projekty/Ogród/Plan nasadzeń.md", "# Plan nasadzeń\nPomidory, ogórki i cebula na grządce południowej. Podlewanie wieczorem.\n"),
    ("n04", "Spotkania/2026-03-12 Budżet.md", "---\ntags: [spotkanie, budzet]\n---\n# Spotkanie o budżecie\n## Ustalenia\nZarząd zatwierdził budżet na II kwartał. Koszty marketingu obniżono o 15 procent.\n"),
    ("n05", "Spotkania/2026-02-03 Retro.md", "# Retrospektywa\nCo poszło dobrze, co wymaga poprawy. Zbyt długie code review.\n"),
    ("n06", "Spotkania/2026-04-20 Serwer.md", "---\ntags: [spotkanie, infrastruktura]\n---\n# Serwer\n## Decyzja\nDecyzja o migracji na nowy serwer w centrum danych. Awaria dysku w starym serwerze.\n"),
    ("n07", "Przepisy/Szarlotka.md", "---\ntags: [przepis, ciasto]\n---\n# Szarlotka\nSkładniki: jabłka, mąka, masło, cukier. Piec 45 minut w 180 stopniach.\n## Krem\nŚmietana 30 procent, cukier puder.\n"),
    ("n08", "Przepisy/Pierogi ruskie.md", "---\ntags: [przepis]\n---\n# Pierogi ruskie\nCiasto na pierogi, twaróg, ziemniaki i cebula. Lepimy ręcznie.\n"),
    ("n09", "Podróże/Islandia 2025.md", "---\ntags: [podróż, islandia]\n---\n# Islandia\n## Trasa\nReykjavik, Vik, lodowiec Vatnajökull. Wodospad Seljalandsfoss.\n## Koszty wyjazdu\nWynajem auta 1200 euro.\n"),
    ("n10", "Podróże/Lizbona.md", "---\ntags: [podróż]\n---\n# Lizbona\nTramwaj 28, pastéis de nata, dzielnica Alfama. Bilet dobowy.\n"),
    ("n11", "Projekty/Dom/Remont łazienki.md", "---\ntags: [projekt, dom]\n---\n# Remont łazienki\n## Wykonawca\nHydraulik przyjdzie w poniedziałek. Płytki z gresu 60x60. Budżet remontu 25 tysięcy.\n"),
    ("n12", "Zadania/Admin.md", "---\ntags: [zadania]\n---\n# Admin\n- [ ] Opłacić fakturę za serwer @jan 📅 2026-05-10\n- [x] Zgłosić zmianę adresu\n- [ ] Odnowić domenę !trudnosc:3\n"),
    ("n13", "Projekty/Triton/Ryzyka.md", "---\ntags: [projekt, triton, ryzyko]\n---\n# Ryzyka\nOpóźnienie dostawy sprzętu. Brak kluczowego konsultanta w sierpniu.\n"),
    ("n14", "Wiedza/Java vs Rust.md", "---\ntags: [programowanie]\n---\n# Java vs Rust\nZarządzanie pamięcią, wątki i kompilacja. Rust daje gwarancje w czasie kompilacji.\n"),
    ("n15", "Wiedza/Kawa.md", "---\ntags: [hobby/kawa]\n---\n# Kawa\nParzenie kawy: french press, 93 stopnie, mielenie średnie.\n"),
    ("n16", "Spotkania/2026-05-06 Klienci.md", "---\ntags: [spotkanie, klient]\n---\n# Klienci\n## Kowalski\nZamówienie na 40 licencji. Termin płatności 30 dni. Faktura zostanie wysłana.\n"),
    ("n17", "Projekty/Ogród/Nawadnianie.md", "# Nawadnianie\nSystem kroplujący, zegar sterujący, zbiornik na deszczówkę 300 litrów.\n"),
    ("n18", "Finanse/Budżet domowy.md", "---\ntags: [finanse, budzet]\n---\n# Budżet domowy\nMiesięczny budżet: czynsz, prąd, internet. Oszczędności na wakacje.\n"),
    ("n19", "Finanse/Subskrypcje.md", "---\ntags: [finanse]\n---\n# Subskrypcje\nChmura 39 zł, muzyka 24 zł, serwer VPS 85 zł miesięcznie.\n"),
    ("n20", "Praca/Onboarding.md", "---\ntags: [praca]\n---\n# Onboarding\nPierwszy tydzień: dostęp do systemów, szkolenie z bezpieczeństwa, spotkanie z zespołem.\n"),
    ("n21", "Praca/Wymagania rekrutacja.md", "---\ntags: [praca, rekrutacja]\n---\n# Wymagania\nKandydat zna Rust lub Go, ma doświadczenie z systemami rozproszonymi.\n"),
    ("n22", "Zdrowie/Bieganie.md", "---\ntags: [zdrowie, sport]\n---\n# Bieganie\nPlan biegowy: 5 km we wtorki, 10 km w soboty. Buty wymienić po 600 km.\n"),
    ("n23", "Zdrowie/Dieta.md", "---\ntags: [zdrowie]\n---\n# Dieta\nOwsianka, kurczak z ryżem, sałatka. Woda dwa litry dziennie.\n"),
    ("n24", "Projekty/Triton/Dostawcy.md", "---\ntags: [projekt, triton, dostawcy]\n---\n# Dostawcy\n## Umowy\nFirma Alfa dostarcza sprzęt, firma Beta licencje. Umowa z dostawcą podpisana w kwietniu.\n"),
    ("n25", "Notatki/Pomysły.md", "# Pomysły\nAplikacja do śledzenia nawyków. Książka o historii Gdańska. Kurs fotografii.\n"),
    ("n26", "Projekty/Kanał.md", "---\ntags: [projekt, media]\n---\n# Kanał\nScenariusz odcinka o żurawiach i ptakach migrujących. Montaż w tydzień.\n"),
    ("n27", "Spotkania/2026-06-01 Umowy.md", "---\ntags: [spotkanie, prawo]\n---\n# Umowy\n## Przegląd\nUmowa najmu biura, termin wypowiedzenia 3 miesiące. Aneks do umowy z dostawcą Beta.\n"),
    ("n28", "Wiedza/Terminy.md", "# Terminy\nDeklaracja PIT do 30 kwietnia. Kwartalne zaliczki na podatek.\n"),
    ("n29", "Projekty/Triton/Zespół.md", "---\ntags: [projekt, triton, zespół]\n---\n# Zespół\nAnna prowadzi backend, Piotr odpowiada za interfejs. Konsultant z zewnątrz w sierpniu.\n"),
    ("n30", "Podróże/Plan Kraków.md", "---\ntags: [podróż]\n---\n# Kraków\nWeekend: Wawel, Kazimierz, kawiarnie na Kazimierzu.\n"),
];

const LAYERS: &[(&str, &str, &str, &str)] = &[
    ("f01", "Faktura-2026-03.pdf", "application/pdf", "## Strona 1\nFAKTURA VAT nr 12/03/2026\nSprzedawca: Serwis Komputerowy Alfa. Usługa: serwer dedykowany, miesięczny abonament. Kwota netto 3415 zł.\n\n## Strona 2\nTermin płatności 14 dni. Konto bankowe do przelewu.\n"),
    ("f02", "Faktura-skan-2026-02.pdf", "application/pdf", "## Strona 1\nFAKLURA VAT nr 07/02/2026\nSprzedawca: Serwis Komputerowy Alfa. Usługa: serwer wirtualny. rniesięczny abonament, kwota brutto 1230 zł.\n\n## Strona 2 · niska jakość\nTermin platnosci 14 dni. Konto do przclewu.\n"),
    ("f03", "Umowa-najmu-biura.pdf", "application/pdf", "## Strona 1\nUMOWA NAJMU lokalu biurowego. Wynajmujący i najemca ustalają czynsz 6500 zł.\nOkres wypowiedzenia trzy miesiące.\n\n## Strona 2\nAneks: zmiana powierzchni na 120 m2.\n"),
    ("f04", "List-do-urzedu.pdf", "application/pdf", "## Strona 1\nSzanowni Państwo, w załączeniu przesyłam korektę deklaracji PIT za rok 2025.\nPozdrawiam, Anna.\n"),
    ("f05", "Zdjecie-paragonu.jpg", "image/jpeg", "## Obraz\nPARAGON fiskalny Biedronka: mleko, chleb, masło. Suma 27,40 zł.\n"),
    ("f06", "Umowa-dostawy-Beta.pdf", "application/pdf", "## Strona 1\nUMOWA DOSTAWY licencji nr 44/2026 zawarta z firmą Beta. Przedmiot: 40 licencji. Termin dostawy 30 dni.\n\n## Strona 2 · niska jakość\nKara umowna 0,5 procen t za każdy dzień zwłoki.\n"),
    ("f07", "Skan-wezwania.pdf", "application/pdf", "## Strona 1 · niska jakość\nWezwanie do zaplaty zaleglego czynszu za lokal.\n\n## Strona 2\n_(brak tekstu)_\n"),
    ("f08", "Faktura-Kowalski-2026-05.pdf", "application/pdf", "## Strona 1\nFaktura nr 45/05/2026 dla klienta Kowalski. 40 licencji po 150 zł. Razem 6000 zł.\n"),
    ("f09", "Instrukcja-zolw.pdf", "application/pdf", "## Strona 1\nInstrukcja pielęgnacji żółwia: lampa UVB, kąpiel w ciepłej wodzie, dieta roślinna.\n"),
    ("f10", "Raport-awarii.pdf", "application/pdf", "## Strona 1\nRaport z awarii serwera: dysk twardy uszkodzony, przywrócono kopię zapasową z nocy.\n"),
];

/// Queries with the ids that must be in the top 10 (a doc id or a chunk id).
const QUERIES: &[(&str, &[&str])] = &[
    // inflection
    ("budżetu", &["n01", "n04", "n11", "n18"]),
    ("budżet", &["n01", "n04", "n11", "n18"]),
    ("kosztów", &["n01", "n04", "n09"]),
    ("wypowiedzenia", &["n27", "f03"]),
    ("licencji", &["n16", "f06", "f08"]),
    ("serwerze", &["n06", "n01", "f10"]),
    // diacritics
    ("zolw", &["n02", "f09"]),
    ("Gdansk", &["n25"]),
    ("lazienki", &["n11"]),
    ("zurawi", &["n26"]),
    ("Kraków", &["n30"]),
    // typos
    ("serwerr", &["n06", "f10"]),
    ("Kowalskii", &["n16", "f08"]),
    ("wakacjee", &["n18"]),
    ("islandja", &["n09"]),
    // OCR
    ("faktura", &["f01", "f08", "f02"]),
    ("termin platnosci", &["f01", "f02"]),
    ("faktura serwer", &["f01", "f02"]),
    ("wezwanie do zaplaty", &["f07"]),
    ("kara umowna procent", &["f06", "n04"]),
    ("miesięczny abonament", &["f01", "f02"]),
    ("PIT korekta", &["f04", "n28"]),
    // phrases
    ("\"termin płatności\"", &["f01", "f02"]),
    ("\"budżet projektu\"", &["n01"]),
    // exclusion
    ("serwer -dedykowany", &["n06", "f10"]),
    // tags
    ("tag:triton", &["n01", "n13", "n24", "n29"]),
    ("tag:projekt koszty", &["n01"]),
    ("tag:zdrowie", &["n22", "n23"]),
    ("tag:hobby", &["n15"]),
    ("tag:ryzyko", &["n13"]),
    // paths
    ("path:Projekty/Triton/", &["n01", "n13", "n24", "n29"]),
    ("path:Spotkania/ klient", &["n16"]),
    // file kinds and mime
    ("typ:pdf faktura", &["f01", "f08"]),
    ("typ:obraz paragon", &["f05"]),
    ("file: umowa", &["f03", "f06"]),
    ("w:notatki serwer", &["n06"]),
    ("w:pliki serwer", &["f01", "f02", "f10"]),
    // content
    ("Gustaw żółw", &["n02"]),
    ("wodospad", &["n09"]),
    ("pasteis de nata", &["n10"]),
    ("szarlotka piec", &["n07"]),
    ("wdrozenie", &["n:n01#3"]),
    ("lodowiec", &["n09"]),
    ("ryzyka opóźnienie dostawy", &["n13"]),
    ("onboarding szkolenie bezpieczeństwa", &["n20"]),
    ("kawa french press", &["n15"]),
    ("Anna backend", &["n29"]),
    ("dostawca Beta aneks", &["n27", "n24"]),
    ("odnowić domenę", &["n12"]),
    ("fotografii kurs", &["n25"]),
];

/// Held-out set: OCR errors in the documents and typos (single-letter substitutions l/t, i/l, e/c, 0/o, 1/l,
/// rn/m, transpositions, missing or extra letters) in the queries. Written against the same corpus after the
/// first set was fixed, and used to measure the edit-distance fallback.
const QUERIES_OCR: &[(&str, &[&str])] = &[
    ("fakura", &["f02"]),
    ("faklura vat", &["f02"]),
    ("piatnosci", &["f01", "f02"]),
    ("miesieczny", &["f01", "f02"]),
    ("przelewu", &["f01", "f02"]),
    ("procent", &["f06", "n04", "n07"]),
    ("rniesięczny", &["f02"]),
    ("zaleglego", &["f07"]),
    ("wezwanie", &["f07"]),
    ("zaplaty czynszu", &["f07"]),
    ("1odowiec", &["n09"]),
    ("w0dospad", &["n09"]),
    ("todowiec", &["n09"]),
    ("kazirnierzu", &["n30"]),
    ("tramwai", &["n10"]),
    ("pasteiss", &["n10"]),
    ("budzrt", &["n01", "n04", "n11", "n18"]),
    ("wdrozenje", &["n:n01#3"]),
    ("harmonogran", &["n:n01#3"]),
    ("Plotr", &["n29"]),
    ("onbaording", &["n20"]),
    ("konsultnt", &["n13", "n29"]),
    ("szarlotak", &["n07"]),
    ("kawiarnle", &["n30"]),
    ("lazienka", &["n11"]),
    ("gustawen", &["n02"]),
    ("zurawach", &["n26"]),
    ("pierogy", &["n08"]),
    ("Lizbonna", &["n10"]),
    ("Wawei", &["n30"]),
];

fn build(stem: bool) -> SearchIndex {
    let mut idx = SearchIndex::with_stemming(stem);
    for (id, path, text) in NOTES {
        idx.upsert_note(id, path, text);
    }
    for (id, name, mime, md) in LAYERS {
        let layer = format!("---\nschema: notes-filetext-v1\nmethod: mixed\n---\n{md}");
        idx.upsert_file_text(id, name, mime, &layer).expect("corpus layers are well formed");
    }
    idx
}

/// (recall@10, MRR) of one query set.
fn evaluate(idx: &SearchIndex, queries: &[(&str, &[&str])]) -> (f32, f32) {
    let mut found = 0usize;
    let mut rr = 0.0f32;
    for (query, expected) in queries {
        let page = idx.search(query, 10, 0, None);
        let rank = page.hits.iter().position(|h| expected.iter().any(|e| h.doc_id == *e || h.chunk_id == *e));
        if let Some(r) = rank {
            found += 1;
            rr += 1.0 / (r as f32 + 1.0);
        }
    }
    let n = queries.len() as f32;
    (found as f32 / n, rr / n)
}

#[test]
fn evaluation_set_has_fifty_queries() {
    assert_eq!(QUERIES.len(), 50);
    assert!(NOTES.len() >= 30);
    assert!(LAYERS.len() >= 10);
}

#[test]
fn recall_at_ten_and_mrr() {
    assert_eq!(QUERIES_OCR.len(), 30);
    let idx = build(false);
    let main = evaluate(&idx, QUERIES);
    let held = evaluate(&idx, QUERIES_OCR);
    let stemmed = evaluate(&build(true), QUERIES);
    println!(
        "search eval main set ({} queries): recall@10 = {:.3}, MRR = {:.3}; held-out OCR/typo set ({} queries): recall@10 = {:.3}, MRR = {:.3}; main set with suffix stripping: recall@10 = {:.3}, MRR = {:.3}",
        QUERIES.len(), main.0, main.1, QUERIES_OCR.len(), held.0, held.1, stemmed.0, stemmed.1
    );
    assert!(main.0 >= 0.9, "main set recall@10 is {:.3}", main.0);
    assert!(held.0 >= 0.9, "held-out set recall@10 is {:.3}", held.0);
}
