// Pure helpers: no DOM, no Web Audio. Testable in Node.

export const TARGET_RATE = 44100;
/** Make a sampler-safe name: [A-Z0-9_-], max 8 chars. */
export function cleanName(s) {
  const n = String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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

/**
 * Pick n windows of `len` seconds inside [0, dur] ("dig").
 *  - random: random detected hits (falls back to anywhere), avoiding overlap
 *    with `taken` ranges and with each other when possible.
 *  - spread: evenly spread across the audio, each snapped to the nearest hit.
 *  - row:    back to back from `from`, shifted left if they would run past the end.
 * Returns [start, end] pairs sorted by start.
 */
export function digRanges({ onsets = [], dur, n, len, mode = 'random', from = 0, taken = [], rand = Math.random }) {
  const L = Math.min(len, dur);
  const maxStart = dur - L;
  if (n <= 0 || L <= 0) return [];
  const nearest = (t, within) => {
    let best = t, d = within;
    for (const o of onsets) if (o <= maxStart && Math.abs(o - t) < d) { d = Math.abs(o - t); best = o; }
    return best;
  };
  let starts;
  if (mode === 'row') {
    const fit = Math.max(1, Math.min(n, Math.floor(dur / L)));
    const s0 = Math.max(0, Math.min(from, dur - fit * L));
    starts = Array.from({ length: fit }, (_, i) => s0 + i * L);
  } else if (mode === 'spread') {
    const slot = dur / n;
    starts = Array.from({ length: n }, (_, i) => nearest(Math.max(0, Math.min(maxStart, slot * (i + 0.5) - L / 2)), slot / 2));
  } else {
    const pool = onsets.filter((t) => t <= maxStart);
    const busy = taken.map(([a, b]) => [a, b]);
    const free = (s) => busy.every(([a, b]) => s + L <= a || s >= b);
    starts = [];
    for (let i = 0; i < n; i++) {
      let s = null;
      for (let tries = 0; tries < 200 && s == null; tries++) {
        const c = pool.length && tries < 150 ? pool[Math.floor(rand() * pool.length)] : rand() * maxStart;
        if (free(c)) s = c;
      }
      if (s == null) s = pool.length ? pool[Math.floor(rand() * pool.length)] : rand() * maxStart;
      busy.push([s, s + L]);
      starts.push(s);
    }
  }
  return starts.map((s) => [s, Math.min(dur, s + L)]).sort((a, b) => a[0] - b[0]);
}

// --- "Quantum" dig (Randonautica-style anomalies) ---

// Parity of a sample's 24-bit value: mixes every bit, so it still works for 16-bit sources.
function parity24(x) {
  let v = Math.round(x * 8388608) & 0xffffff;
  v ^= v >> 16; v ^= v >> 8; v ^= v >> 4; v ^= v >> 2; v ^= v >> 1;
  return v & 1;
}

/** Random bits from physical noise: sample parities, debiased with von Neumann's extractor. */
export function noiseBits(samples) {
  const out = [];
  for (let i = 0; i + 1 < samples.length; i += 2) {
    const a = parity24(samples[i]), b = parity24(samples[i + 1]);
    if (a !== b) out.push(a);
  }
  return out;
}

/** n positions in [0, dur), 16 bits each (bits are consumed in order). */
export function bitsToPoints(bits, n, dur) {
  const pts = [];
  for (let i = 0; i < n && (i + 1) * 16 <= bits.length; i++) {
    let v = 0;
    for (let j = 0; j < 16; j++) v = (v << 1) | bits[i * 16 + j];
    pts.push((v / 65536) * dur);
  }
  return pts;
}

/**
 * Probability anomalies on the timeline: count random points in every window of `len`
 * and score it against a uniform spread (Poisson z-score). 'attractor' takes the densest
 * windows, 'void' the emptiest; picks don't overlap each other or `taken`, and starts snap
 * to a nearby hit. Returns { ranges, z } with z of the strongest anomaly.
 */
export function anomalyRanges({ points, dur, n, len, kind = 'attractor', taken = [], onsets = [] }) {
  const L = Math.min(len, dur), maxStart = Math.max(0, dur - L);
  if (!points.length || n <= 0 || L <= 0) return { ranges: [], z: 0 };
  const pts = Float64Array.from(points).sort();
  const lambda = (pts.length * L) / dur;
  const lower = (t) => { let lo = 0, hi = pts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m] < t) lo = m + 1; else hi = m; } return lo; };
  const G = 800, cands = [];
  for (let g = 0; g <= G; g++) {
    const s = (maxStart * g) / G;
    const c = lower(s + L) - lower(s);
    cands.push({ s, z: (c - lambda) / Math.sqrt(lambda || 1) });
  }
  cands.sort((a, b) => (kind === 'void' ? a.z - b.z : b.z - a.z));
  const busy = taken.map(([a, b]) => [a, b]), picks = [];
  for (const c of cands) {
    if (picks.length >= n) break;
    if (busy.every(([a, b]) => c.s + L <= a || c.s >= b)) { picks.push(c); busy.push([c.s, c.s + L]); }
  }
  const snap = (s) => {
    let best = s, d = 0.12;
    for (const o of onsets) if (o <= maxStart && Math.abs(o - s) < d) { d = Math.abs(o - s); best = o; }
    return best;
  };
  const ranges = picks.map((p) => { const s = snap(p.s); return [s, Math.min(dur, s + L)]; }).sort((a, b) => a[0] - b[0]);
  return { ranges, z: picks.length ? picks[0].z : 0 };
}

// Output level per slice: peak gain drive (dB) into the limiter, or null to leave it untouched.
export const LEVELS = { off: null, norm: 0, loud: 6, max: 12 };
const CEILING = 0.966; // -0.3 dBFS

/**
 * Peak-normalize, then push `driveDb` into a look-ahead limiter so quiet tails
 * come up while peaks stay under CEILING. In place.
 */
function level(channels, driveDb, rate) {
  const len = channels[0].length;
  let peak = 0;
  for (const c of channels) for (let i = 0; i < len; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
  if (!peak) return;
  const gain = 10 ** (driveDb / 20) / peak; // after this the loudest sample sits at +driveDb dBFS
  if (driveDb <= 0) { for (const c of channels) for (let i = 0; i < len; i++) c[i] *= gain * CEILING; return; }

  // Gain each sample needs to stay under the ceiling.
  const need = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let p = 0;
    for (const c of channels) { const a = Math.abs(c[i]); if (a > p) p = a; }
    p *= gain;
    need[i] = p > CEILING ? CEILING / p : 1;
  }
  // Look ahead: start reducing L samples before a peak, then release smoothly.
  const L = Math.max(1, Math.round(0.002 * rate));
  const rel = 1 - Math.exp(-1 / (0.06 * rate));
  const env = new Float32Array(len);
  const dq = new Int32Array(len); // monotonic deque for the sliding minimum of need[i..i+L]
  let head = 0, tail = 0, g = 1;
  for (let j = 0; j < Math.min(len, L); j++) { while (tail > head && need[dq[tail - 1]] >= need[j]) tail--; dq[tail++] = j; }
  for (let i = 0; i < len; i++) {
    const j = i + L;
    if (j < len) { while (tail > head && need[dq[tail - 1]] >= need[j]) tail--; dq[tail++] = j; }
    while (dq[head] < i) head++;
    const m = need[dq[head]];
    g = m < g ? m : g + (m - g) * rel;
    env[i] = g;
  }
  // Average the last L gains so the reduction ramps in instead of stepping (still <= need at every peak).
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += env[i] - (i >= L ? env[i - L] : 0);
    const k = gain * (sum + Math.max(0, L - 1 - i)) / L;
    for (const c of channels) {
      const y = c[i] * k;
      c[i] = y > CEILING ? CEILING : y < -CEILING ? -CEILING : y;
    }
  }
}

/**
 * Post-process rendered channels in place: reverse, level, fades.
 * channels: Float32Array[] at TARGET_RATE; lvl is a LEVELS key.
 */
export function finish(channels, { reverse, lvl = 'norm', fadeInMs, fadeOutMs }) {
  const len = channels[0].length;
  if (reverse) channels.forEach((c) => c.reverse());
  if (LEVELS[lvl] != null) level(channels, LEVELS[lvl], TARGET_RATE);
  const fi = Math.min(len, Math.round((fadeInMs / 1000) * TARGET_RATE));
  const fo = Math.min(len, Math.round((fadeOutMs / 1000) * TARGET_RATE));
  for (const c of channels) {
    for (let i = 0; i < fi; i++) c[i] *= i / fi;
    for (let i = 0; i < fo; i++) c[len - 1 - i] *= i / fo;
  }
  return channels;
}

/** 16-bit PCM WAV (little-endian, interleaved). */
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
  // Browsers run on little-endian hardware, so a typed view writes WAV byte order directly.
  const pcm = new Int16Array(buf, 44, len * nCh);
  for (let c = 0; c < nCh; c++) {
    const d = channels[c];
    for (let i = 0, o = c; i < len; i++, o += nCh) {
      const s = d[i] > 1 ? 1 : d[i] < -1 ? -1 : d[i];
      pcm[o] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
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
function crc32(data) {
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
