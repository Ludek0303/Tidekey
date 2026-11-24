//! Performance check at the size of OCR §4.3: 10 000 notes and 2 000 file layers, about 50 MB of text, generated
//! with a fixed seed. Release builds assert build < 10 s and median query < 50 ms; debug builds only print.

use std::time::{Duration, Instant};

use super::SearchIndex;

const SYLLABLES: &[&str] = &[
    "ka", "ro", "ży", "ci", "ła", "wo", "dom", "pro", "jek", "tu", "mi", "ędz", "ski", "ną", "sza", "lot", "ko", "ści", "wy",
    "nie", "ba", "ter", "ma", "gis", "ó", "ce", "ne", "rza", "czy", "ol", "ąt", "sy", "ło", "fa", "ktu", "ra", "ser", "wer",
    "bu", "dżet",
];
const VOCAB: usize = 40_000;

/// xorshift64*: small, seeded, the same sequence on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    /// Skewed towards small indexes, like word frequencies.
    fn zipf(&mut self, n: usize) -> usize {
        let u = (self.next() % 1_000_000) as f64 / 1_000_000.0;
        ((n as f64) * u * u * u) as usize % n
    }
}

fn word(vocab: &[String], rng: &mut Rng) -> String {
    vocab[rng.zipf(vocab.len())].clone()
}

fn paragraph(vocab: &[String], rng: &mut Rng, target: usize) -> String {
    let mut out = String::new();
    while out.len() < target {
        let words = 6 + rng.below(9);
        let sentence: Vec<String> = (0..words).map(|_| word(vocab, rng)).collect();
        out.push_str(&sentence.join(" "));
        out.push_str(". ");
    }
    out.trim_end().to_string()
}

fn note(vocab: &[String], rng: &mut Rng) -> (String, String) {
    let target = 2000 + rng.below(3000);
    let mut text = format!("---\ntags: [{}, {}]\n---\n# {}\n", word(vocab, rng), word(vocab, rng), word(vocab, rng));
    let mut section = 0;
    while text.len() < target {
        if section % 3 == 0 {
            text.push_str(&format!("## {}\n", word(vocab, rng)));
        }
        text.push_str(&paragraph(vocab, rng, 400));
        text.push_str("\n\n");
        section += 1;
    }
    (format!("Folder{}/Notatka {}.md", rng.below(50), word(vocab, rng)), text)
}

fn layer(vocab: &[String], rng: &mut Rng) -> String {
    let mut md = String::from("---\nschema: notes-filetext-v1\nmethod: mixed\n---\n\n");
    for page in 1..=2 {
        let flag = if rng.below(10) == 0 { " · niska jakość" } else { "" };
        md.push_str(&format!("## Strona {page}{flag}\n"));
        md.push_str(&paragraph(vocab, rng, 3700));
        md.push_str("\n\n");
    }
    md
}

/// Peak resident memory in MB (VmHWM), where the OS reports it.
fn peak_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024.0)
}

#[test]
fn search_perf() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let vocab: Vec<String> = (0..VOCAB)
        .map(|_| {
            let n = 1 + rng.below(4);
            (0..n).map(|_| SYLLABLES[rng.below(SYLLABLES.len())]).collect()
        })
        .collect();
    let notes: Vec<(String, String, String)> = (0..10_000)
        .map(|i| {
            let (path, mut text) = note(&vocab, &mut rng);
            // Map material: a task with a person, a link to another note, and sometimes an embedded file.
            let person = vocab[rng.zipf(VOCAB)].clone();
            text.push_str(&format!("\n- [ ] Przygotować @{person} materiały\n"));
            if rng.below(5) == 0 {
                text.push_str(&format!("![[plik:{:032x}]]\n", 1 + rng.below(2_000)));
            }
            (format!("n{i}"), path, text)
        })
        .collect();
    let layers: Vec<String> = (0..2_000).map(|_| layer(&vocab, &mut rng)).collect();
    let text_bytes: usize = notes.iter().map(|(_, _, t)| t.len()).sum::<usize>() + layers.iter().map(String::len).sum::<usize>();
    let people: Vec<String> = (0..300).map(|_| vocab[rng.zipf(VOCAB)].clone()).filter(|p| p.chars().count() >= 4).collect();

    let queries: Vec<String> = (0..50)
        .map(|i| {
            let words = 1 + i % 3;
            let mut q: Vec<String> = (0..words).map(|_| word(&vocab, &mut rng)).collect();
            if i % 5 == 0 {
                q.push(vocab[rng.below(VOCAB)].clone());
            }
            if i % 7 == 0 {
                let w = q.last_mut().expect("at least one word");
                w.push('x');
            }
            q.join(" ")
        })
        .collect();

    let start = Instant::now();
    let mut idx = SearchIndex::new();
    for (id, path, body) in &notes {
        idx.upsert_note(id, path, body);
    }
    for (i, md) in layers.iter().enumerate() {
        idx.upsert_file_text(&format!("{:032x}", i + 1), &format!("Skan {i}.pdf"), "application/pdf", md)
            .expect("generated layers are well formed");
    }
    for (i, (id, _, _)) in notes.iter().enumerate() {
        let targets: Vec<String> = (0..2).map(|k| format!("n{}", (i * 7 + k * 13) % notes.len())).collect();
        idx.set_links(id, &targets);
    }
    idx.set_people(&people);
    let build = start.elapsed();

    // Mentions and the graph: the first overview builds the mention cache, then the graph.
    let start = Instant::now();
    let overview = idx.map_overview(None);
    let graph_build = start.elapsed();
    let edges = idx.build_graph(None).edges.len();
    println!(
        "search perf graph: index build {:.2} s, first map_overview (mentions + graph) {:.2} s, edges {edges}, files {}, top tag {:?}",
        build.as_secs_f64(),
        graph_build.as_secs_f64(),
        overview.files_total,
        overview.top_tags.first(),
    );

    let postings = idx.inv.post_len();
    let heap = idx.heap_bytes();
    println!(
        "search perf: text {:.1} MB, chunks {}, (term, chunk) postings {postings}, index heap {:.1} MB, peak RSS {} MB",
        text_bytes as f64 / 1e6,
        idx.chunks.len(),
        heap as f64 / 1e6,
        peak_mb().map_or("n/a".to_string(), |m| format!("{m:.0}")),
    );

    let mut times: Vec<Duration> = Vec::with_capacity(queries.len());
    let mut hits = 0usize;
    for q in &queries {
        let t = Instant::now();
        hits += idx.search(q, 10, 0, None).total;
        times.push(t.elapsed());
    }
    times.sort();
    let median = times[times.len() / 2];
    let max = *times.last().expect("50 queries");

    let mut nb_times: Vec<Duration> = Vec::new();
    for i in (0..notes.len()).step_by(notes.len() / 20) {
        let t = Instant::now();
        let _ = idx.neighbors(&format!("n:n{i}"), 2, None, 30, None);
        nb_times.push(t.elapsed());
    }
    nb_times.sort();
    let nb_median = nb_times[nb_times.len() / 2];

    let t = Instant::now();
    let found = idx.find_files(None, Some("pdf"), None, 50, 0, None);
    let ff = t.elapsed();
    println!(
        "search perf: 50 queries, median {:.2} ms, max {:.2} ms, total hits {hits}; neighbors depth 2 (20 nodes) median {:.2} ms; find_files {:.2} ms ({} files)",
        median.as_secs_f64() * 1e3,
        max.as_secs_f64() * 1e3,
        nb_median.as_secs_f64() * 1e3,
        ff.as_secs_f64() * 1e3,
        found.total,
    );
    println!(
        "search perf: index heap {:.1} MB (with the mention cache), peak RSS {} MB",
        heap as f64 / 1e6,
        peak_mb().map_or("n/a".to_string(), |m| format!("{m:.0}")),
    );

    if !cfg!(debug_assertions) {
        assert!(build + graph_build < Duration::from_secs(10), "build + graph took {:?}", build + graph_build);
        assert!(median < Duration::from_millis(50), "median query took {median:?}");
        assert!(heap < 250_000_000, "index heap is {} MB", heap / 1_000_000);
    }
}
