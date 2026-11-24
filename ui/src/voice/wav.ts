// Minimal WAV reader for the measurement set (docs/DYKTOWANIE.md §8): PCM16 and IEEE float32, any channel count.
export function parseWav(buf: ArrayBuffer): { rate: number; pcm: Float32Array } {
  const dv = new DataView(buf);
  const id = (at: number) => String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));
  if (buf.byteLength < 12 || id(0) !== "RIFF" || id(8) !== "WAVE") throw new Error("To nie jest plik WAV (brak RIFF/WAVE)");

  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: { at: number; size: number } | null = null;
  // Chunks are read in order until both are found; odd-sized chunks are padded to an even length.
  for (let at = 12; at + 8 <= buf.byteLength && !(fmt && data); ) {
    const size = dv.getUint32(at + 4, true);
    const body = at + 8;
    if (id(at) === "fmt ") {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        rate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id(at) === "data") {
      data = { at: body, size: Math.min(size, buf.byteLength - body) };
    }
    at = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("Brak chunka fmt lub data w pliku WAV");

  const ok = (fmt.format === 1 && fmt.bits === 16) || (fmt.format === 3 && fmt.bits === 32);
  if (!ok) throw new Error(`Nieobsługiwany format WAV: ${fmt.format}, ${fmt.bits} bitów (obsługiwane: PCM 16-bit, float 32-bit)`);
  if (fmt.channels < 1) throw new Error("Plik WAV bez kanałów");

  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.size / (bytes * fmt.channels));
  const pcm = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const at = data.at + (f * fmt.channels + c) * bytes;
      sum += fmt.bits === 16 ? dv.getInt16(at, true) / 32768 : dv.getFloat32(at, true);
    }
    pcm[f] = sum / fmt.channels;
  }
  return { rate: fmt.rate, pcm };
}
