// Word and character error rates for the dictation measurement (docs/DYKTOWANIE.md §8).
export interface Score {
  errors: number;
  total: number;
  rate: number;
}

// Plain normalization for WER/CER: lowercase, punctuation and extra spaces removed.
export function normalize(text: string): string {
  return text
    .toLocaleLowerCase("pl")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Single-row Levenshtein distance over any sequence of tokens.
function levenshtein<T>(a: T[], b: T[]): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      next[j] = Math.min(sub, row[j] + 1, next[j - 1] + 1);
    }
    row = next;
  }
  return row[b.length];
}

function score(refTokens: string[], hypTokens: string[]): Score {
  const errors = levenshtein(refTokens, hypTokens);
  const total = refTokens.length;
  return { errors, total, rate: total ? errors / total : 0 };
}

const words = (text: string): string[] => normalize(text).split(" ").filter(Boolean);

export function wer(ref: string, hyp: string): Score {
  return score(words(ref), words(hyp));
}

// Characters of the normalized text, spaces included.
export function cer(ref: string, hyp: string): Score {
  return score(Array.from(normalize(ref)), Array.from(normalize(hyp)));
}

// No normalization: case and punctuation count, as punctuation marks are separate tokens.
const tokensRaw = (text: string): string[] => text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];

export function werCased(ref: string, hyp: string): Score {
  return score(tokensRaw(ref), tokensRaw(hyp));
}

// Micro-average: errors and totals are summed first, then divided.
export function aggregate(scores: Score[]): Score {
  const errors = scores.reduce((n, s) => n + s.errors, 0);
  const total = scores.reduce((n, s) => n + s.total, 0);
  return { errors, total, rate: total ? errors / total : 0 };
}
