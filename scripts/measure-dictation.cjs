// Dictation quality and speed on a WAV + transcript set (docs/DYKTOWANIE.md §8). Dev server must be running:
//   PLAYWRIGHT_PATH=/path/to/playwright node scripts/measure-dictation.cjs [--limit N] [--configs m:enc:backend,...]
// Options: --url, --set DIR, --out FILE, --timeout MIN (per configuration, default 30). CHROMIUM_PATH selects the browser.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIGS = [
  "parakeet-ultra-b27f93c:encoderCpu:wasm",
  "parakeet-ultra-b27f93c:encoderQ4:wasm",
  "parakeet-ultra-b27f93c:encoderQ4:webgpu",
  "parakeet-ultra-b27f93c:encoderGpu:webgpu",
  "parakeet-v3-e5356bf:encoderCpu:wasm",
  "parakeet-v3-e5356bf:encoderGpu:webgpu",
];
const ROOT = path.resolve(__dirname, "..");
const WEBGPU_FLAGS = ["--enable-unsafe-webgpu", "--use-angle=vulkan", "--enable-features=Vulkan"];

function parseArgs(argv) {
  const opt = {
    url: "http://127.0.0.1:5174",
    set: path.join(ROOT, "pomiary", "fleurs-pl-50"),
    limit: Infinity,
    configs: DEFAULT_CONFIGS,
    out: path.join(ROOT, "pomiary", `wyniki-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.json`),
    timeoutMin: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`brak wartości dla ${key}`);
      return argv[++i];
    };
    if (key === "--url") opt.url = val();
    else if (key === "--set") opt.set = path.resolve(process.cwd(), val());
    else if (key === "--limit") opt.limit = Number(val());
    else if (key === "--configs") opt.configs = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (key === "--out") opt.out = path.resolve(process.cwd(), val());
    else if (key === "--timeout") opt.timeoutMin = Number(val());
    else throw new Error(`nieznana opcja ${key}`);
  }
  // Each configuration is "model:encoder:backend"; checked here so a typo does not cost a model load.
  for (const c of opt.configs) {
    if (c.split(":").length !== 3) throw new Error(`zła konfiguracja ${c} (oczekiwano model:koder:backend)`);
  }
  return opt;
}

// Pairs NN-xxx.wav with NN-xxx.txt; the .txt is the reference transcript.
function loadSet(dir, limit) {
  const wavs = fs.readdirSync(dir).filter((f) => f.endsWith(".wav")).sort().slice(0, limit);
  if (!wavs.length) throw new Error(`brak plików WAV w ${dir}`);
  return wavs.map((wav) => {
    const base = wav.slice(0, -4);
    const txt = path.join(dir, `${base}.txt`);
    if (!fs.existsSync(txt)) throw new Error(`brak transkrypcji ${base}.txt`);
    return { name: base, file: path.join(dir, wav), ref: fs.readFileSync(txt, "utf8").trim() };
  });
}

const pct = (x) => `${(x * 100).toFixed(1)} %`;
const ms = (x) => (x == null ? "—" : `${Math.round(x)} ms`);
const short = (s) => String(s).split("\n")[0].replace(/^(Error: )+/, "").slice(0, 160);
const log = (s) => process.stderr.write(`${s}\n`);

function table(results) {
  const head = [
    "| Model | Koder | Backend | WER | CER | WER z interpunkcją i wielkością liter | RTF | Opóźnienie fragmentu (mediana / p95) | Ładowanie modelu | Fragmenty |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  const rows = results.map((r) => {
    const [model, encoder, backend] = [r.config.model, r.config.encoder, r.config.backend];
    if (r.aborted) return `| ${model} | ${encoder} | ${backend} | przerwano | | | | | | |`;
    if (r.error) return `| ${model} | ${encoder} | ${backend} | nie działa: ${short(r.error)} | | | | | | |`;
    const t = r.totals;
    return `| ${model} | ${encoder} | ${backend} | ${pct(t.wer.rate)} | ${pct(t.cer.rate)} | ${pct(t.werCased.rate)} | ${t.rtf.toFixed(3)} | ${ms(t.latencyMedianMs)} / ${ms(t.latencyP95Ms)} | ${(r.loadMs / 1000).toFixed(1)} s | ${t.fragments} |`;
  });
  return [...head, ...rows].join("\n");
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const files = loadSet(opt.set, opt.limit);
  const payload = files.map((f) => ({ name: `${f.name}.wav`, wav: `/__pomiary__/${f.name}.wav`, ref: f.ref }));
  const byName = new Map(files.map((f) => [`${f.name}.wav`, f.file]));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: WEBGPU_FLAGS });

  // Serves the set from disk under /__pomiary__/, so the Vite config stays unchanged.
  const openPage = async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await context.route("**/__pomiary__/**", (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
      const file = byName.get(name);
      if (!file) return route.fulfill({ status: 404 });
      return route.fulfill({ status: 200, contentType: "audio/wav", body: fs.readFileSync(file) });
    });
    const page = await context.newPage();
    await page.goto(`${opt.url}/measure.html`);
    await page.waitForFunction(() => typeof window.runMeasure === "function", null, { timeout: 120000 });
    return { context, page };
  };

  const started = new Date().toISOString();
  const { context: hwContext, page: hwPage } = await openPage();
  const hardware = await hwPage.evaluate(() => window.hardware());
  await hwContext.close();

  const results = [];
  const write = () =>
    fs.writeFileSync(opt.out, JSON.stringify({ startedAt: started, url: opt.url, set: opt.set, files: files.length, hardware, results }, null, 2));
  fs.mkdirSync(path.dirname(opt.out), { recursive: true });

  for (const spec of opt.configs) {
    const [model, encoder, backend] = spec.split(":");
    const config = { model, encoder, backend };
    log(`[${spec}] start (${files.length} plików)`);
    const t0 = Date.now();
    const { context, page } = await openPage();
    let timer;
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ config, error: `przerwano po ${opt.timeoutMin} min`, aborted: true }), opt.timeoutMin * 60000);
    });
    const run = page.evaluate(([c, f]) => window.runMeasure(c, f), [config, payload]).catch((e) => ({ config, error: String(e.message ?? e) }));
    const result = await Promise.race([run, limit]);
    clearTimeout(timer);
    await context.close();
    results.push(result);
    write();
    log(`[${spec}] ${result.error ? `błąd: ${short(result.error)}` : `WER ${pct(result.totals.wer.rate)}, RTF ${result.totals.rtf.toFixed(3)}`} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  await browser.close();
  write();

  const ok = results.filter((r) => !r.error);
  const audioSec = ok.length ? ok[0].totals.audioSec : 0;
  const best = ok.reduce((b, r) => (b == null || r.totals.wer.rate < b.totals.wer.rate ? r : b), null);
  const worst = best ? [...best.files].sort((a, b) => b.wer.rate - a.wer.rate).slice(0, 3) : [];
  const hw = hardware.webgpu;
  const lines = [
    table(results),
    "",
    "**Sprzęt**",
    `- userAgent: ${hardware.userAgent}`,
    `- navigator.hardwareConcurrency: ${hardware.hardwareConcurrency}, crossOriginIsolated: ${hardware.crossOriginIsolated}`,
    `- WebGPU: ${hw ? `vendor ${hw.vendor || "—"}, architektura ${hw.architecture || "—"}, shader-f16: ${hw.shaderF16 ? "tak" : "nie"}` : "brak adaptera"}`,
    `- Pliki: ${files.length}, łączny czas audio: ${audioSec.toFixed(1)} s`,
    "",
  ];
  if (best) {
    lines.push(`**Najlepsza konfiguracja (najniższy WER):** ${best.config.model}:${best.config.encoder}:${best.config.backend}`, "");
    lines.push("**Trzy pliki z najwyższym WER:**");
    for (const f of worst) {
      lines.push(`- ${f.name} (WER ${pct(f.wer.rate)})`, `  - ref: ${f.ref}`, `  - hyp: ${f.hyp}`);
    }
  }
  lines.push("", `JSON: ${opt.out}`);
  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
