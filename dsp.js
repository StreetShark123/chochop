// Pure helpers: no DOM, no Web Audio. Testable in Node.

export const TARGET_RATE = 44100;
// Wave Bard sample memory: 7.5 MiB of 16-bit samples ≈ 89 s mono at 44.1 kHz.
export const BUDGET_SAMPLES = Math.floor((7.5 * 1024 * 1024) / 2);
export const BANK_SIZE = 8;

/** Samples a region will use in the Wave Bard's memory once exported. */
export function regionCost(r) {
  const dur = Math.max(0, r.end - r.start) / r.speed;
  return Math.ceil(dur * TARGET_RATE) * (r.mono ? 1 : 2);
}

/** Make a name safe for the Bard web app: [A-Z0-9_-], max 8 chars. */
export function cleanName(s) {
  const n = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]/g, '').toUpperCase().slice(0, 8);
  return n || 'SMP';
}

/** Ensure unique names (case-insensitive), keeping the 8-char limit. */
export function uniqueNames(names) {
  const seen = new Set();
  return names.map((raw) => {
    let base = cleanName(raw);
    let n = base, i = 2;
    while (seen.has(n)) {
      const suf = String(i++);
      n = base.slice(0, 8 - suf.length) + suf;
    }
    seen.add(n);
    return n;
  });
}

/**
 * Onset detection on a mono signal.
 * sensitivity 1 (few cuts) .. 10 (many cuts). Returns onset times in seconds.
 */
export function detectOnsets(data, rate, sensitivity = 5, minGapSec = 0.08) {
  const hop = 512;
  const frames = Math.floor(data.length / hop);
  if (frames < 4) return [0];
  const env = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const o = f * hop;
    for (let i = 0; i < hop; i++) { const v = data[o + i]; s += v * v; }
    env[f] = Math.sqrt(s / hop);
    if (env[f] > peak) peak = env[f];
  }
  if (peak === 0) return [0];
  // Positive spectral-ish flux on the RMS envelope (log domain).
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const a = Math.log10(env[f - 1] + 1e-4), b = Math.log10(env[f] + 1e-4);
    flux[f] = Math.max(0, b - a);
  }
  // Adaptive threshold: local mean + k * global spread.
  let mean = 0;
  for (let f = 0; f < frames; f++) mean += flux[f];
  mean /= frames;
  let sd = 0;
  for (let f = 0; f < frames; f++) sd += (flux[f] - mean) ** 2;
  sd = Math.sqrt(sd / frames);
  const k = 3.2 - (sensitivity - 1) * 0.3; // 3.2 .. 0.5
  const gate = peak * (0.12 - (sensitivity - 1) * 0.011); // ignore quiet bits
  const win = 8;
  const minGap = Math.max(1, Math.round((minGapSec * rate) / hop));
  // Only keep a cut at 0 when the audio already sounds there (no silent lead-in slice).
  const out = Math.max(env[0], env[1], env[2]) > gate ? [0] : [];
  let last = -minGap;
  for (let f = 1; f < frames - 1; f++) {
    let local = 0, c = 0;
    for (let j = Math.max(0, f - win); j <= Math.min(frames - 1, f + win); j++) { local += flux[j]; c++; }
    local /= c;
    const thr = local + k * sd;
    if (flux[f] > thr && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1] && env[f] > gate && f - last >= minGap) {
      const t = (f * hop) / rate;
      if (!out.length || t - out.at(-1) >= minGapSec) out.push(t);
      last = f;
    }
  }
  return out.length ? out : [0];
}

/** Turn onset times into [start, end] pairs, ending at the next onset or maxLen. */
export function onsetsToRanges(onsets, total, maxLen = 4) {
  const r = [];
  for (let i = 0; i < onsets.length; i++) {
    const s = onsets[i];
    const e = Math.min(i + 1 < onsets.length ? onsets[i + 1] : total, s + maxLen, total);
    if (e - s > 0.02) r.push([s, e]);
  }
  return r;
}

export function equalRanges(start, end, parts) {
  const n = Math.max(1, Math.floor(parts));
  const len = (end - start) / n;
  return Array.from({ length: n }, (_, i) => [start + i * len, start + (i + 1) * len]);
}

/**
 * Post-process rendered channels in place: reverse, normalize, fades.
 * channels: Float32Array[] at TARGET_RATE.
 */
export function finish(channels, { reverse, normalize, fadeInMs, fadeOutMs }) {
  const len = channels[0].length;
  if (reverse) channels.forEach((c) => c.reverse());
  if (normalize) {
    let peak = 0;
    for (const c of channels) for (let i = 0; i < len; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
    if (peak > 0) {
      const g = 0.966 / peak; // -0.3 dBFS
      for (const c of channels) for (let i = 0; i < len; i++) c[i] *= g;
    }
  }
  const fi = Math.min(len, Math.round((fadeInMs / 1000) * TARGET_RATE));
  const fo = Math.min(len, Math.round((fadeOutMs / 1000) * TARGET_RATE));
  for (const c of channels) {
    for (let i = 0; i < fi; i++) c[i] *= i / fi;
    for (let i = 0; i < fo; i++) c[len - 1 - i] *= i / fo;
  }
  return channels;
}

/** 16-bit PCM WAV. */
export function encodeWav(channels, rate = TARGET_RATE) {
  const nCh = channels.length, len = channels[0].length;
  const bytes = 44 + len * nCh * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * nCh * 2, true); v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * nCh * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

// --- Minimal store-only ZIP writer ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{name, data: Uint8Array}] → Uint8Array zip */
export function makeZip(files) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true);
    ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

export function fmtTime(s) {
  if (!isFinite(s)) return '–';
  if (s < 60) return s.toFixed(2) + ' s';
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
