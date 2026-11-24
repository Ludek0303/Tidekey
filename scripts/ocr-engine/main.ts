// Test page for scripts/test-ocr-engine.cjs. Built with the app's vite and its engine (the "@engine" alias is set by the
// script), so it runs the same worker, models and pipeline as the app. Not part of the app build.
import { OcrEngine } from "@engine";

const engine = new OcrEngine({ faultInjection: new URLSearchParams(location.search).has("fault") });

// Fetches each fixture, decodes it in the page and recognizes it. Returns text and provider data only. The measurement
// is taken first, so what it chose is reported even when a page later falls back.
async function run(names: string[]) {
  const measured = engine.current() ?? (await engine.measure());
  const out = [];
  for (const name of names) {
    const blob = await (await fetch(`/fixtures/ocr/${name}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const r = await engine.recognize(bitmap);
    out.push({ name, lines: r.lines, noText: r.noText, quality: r.quality, provider: r.provider, ms: r.ms, fellBack: r.fellBack });
  }
  return { gpu: "gpu" in navigator, measured, pages: out };
}

Object.assign(window, { ocrRun: run });
