// Streaming SHA-256 in plain TypeScript. WebCrypto has no incremental mode, and a model file is over 1 GB,
// so the model download has to be hashed chunk by chunk.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export class Sha256 {
  private readonly h = new Uint32Array(H0);
  private readonly w = new Uint32Array(64);
  private readonly buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private hex: string | undefined;

  update(chunk: Uint8Array): this {
    if (this.hex !== undefined) throw new Error("Sha256: digest już policzony");
    this.total += chunk.length;
    let pos = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, chunk.length);
      this.buf.set(chunk.subarray(0, take), this.bufLen);
      this.bufLen += take;
      pos = take;
      if (this.bufLen < 64) return this;
      this.block(this.buf, 0);
      this.bufLen = 0;
    }
    for (; chunk.length - pos >= 64; pos += 64) this.block(chunk, pos);
    if (pos < chunk.length) {
      this.buf.set(chunk.subarray(pos), 0);
      this.bufLen = chunk.length - pos;
    }
    return this;
  }

  digestHex(): string {
    if (this.hex !== undefined) return this.hex;
    const buf = this.buf;
    let n = this.bufLen;
    buf[n++] = 0x80;
    if (n > 56) {
      buf.fill(0, n);
      this.block(buf, 0);
      n = 0;
    }
    buf.fill(0, n, 56);
    // Length in bits, big-endian, 64-bit field. Safe up to 2^53 bytes.
    const bits = this.total * 8;
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    for (let i = 0; i < 4; i++) {
      buf[56 + i] = hi >>> (24 - 8 * i);
      buf[60 + i] = lo >>> (24 - 8 * i);
    }
    this.block(buf, 0);
    let out = "";
    for (const v of this.h) out += v.toString(16).padStart(8, "0");
    this.hex = out;
    return out;
  }

  private block(data: Uint8Array, off: number): void {
    const w = this.w;
    const h = this.h;
    for (let i = 0; i < 16; i++) {
      const j = off + 4 * i;
      w[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      // Uint32Array stores the sum modulo 2^32, which is the wanted wrap-around.
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = hh + s1 + ch + K[i] + w[i];
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = s0 + maj;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
}
