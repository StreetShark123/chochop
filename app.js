import {
  TARGET_RATE, BUDGET_SAMPLES, BANK_SIZE, regionCost, cleanName, uniqueNames,
  detectOnsets, onsetsToRanges, equalRanges, finish, encodeWav, makeZip, fmtTime,
} from './dsp.js';

const $ = (id) => document.getElementById(id);
const els = {
  file: $('file'), drop: $('drop'), editor: $('editor'), fname: $('fname'), fmeta: $('fmeta'),
  wave: $('wave'), overview: $('overview'), regions: $('regions'), count: $('count'),
  memtext: $('memtext'), memfill: $('memfill'), exportBtn: $('export'), toast: $('toast'),
  props: $('props'), noSel: $('noSel'), pInfo: $('pInfo'),
  automode: $('automode'), sens: $('sens'), sensWrap: $('sensWrap'), parts: $('parts'), partsWrap: $('partsWrap'),
};

const state = {
  buffer: null,      // decoded AudioBuffer
  mono: null,        // Float32Array mixdown for display / analysis
  peaks: null,       // {min, max, bin}
  stem: 'SMP',
  regions: [],       // {id, start, end, name, mono, speed, fadeIn, fadeOut, normalize, reverse}
  sel: null,
  view: { start: 0, end: 1 },
  cursor: 0,
  nextId: 1,
};

let actx = null;
let playing = null; // {src, t0, from, to, rate, reverse}
const audio = () => (actx ||= new AudioContext());

// ---------- loading ----------
async function loadFile(file) {
  try {
    toast('Decodificando…');
    const ab = await file.arrayBuffer();
    const buf = await audio().decodeAudioData(ab);
    state.buffer = buf;
    state.mono = mixdown(buf);
    state.peaks = buildPeaks(state.mono);
    state.stem = cleanName(file.name.replace(/\.[^.]+$/, '')).slice(0, 5) || 'SMP';
    state.regions = [];
    state.sel = null;
    state.cursor = 0;
    state.view = { start: 0, end: buf.duration };
    els.fname.textContent = file.name;
    els.fmeta.textContent = `${fmtTime(buf.duration)} · ${buf.numberOfChannels === 1 ? 'mono' : 'estéreo'} · ${buf.sampleRate} Hz`;
    els.drop.hidden = true;
    els.editor.hidden = false;
    resize();
    refresh();
    hideToast();
  } catch (e) {
    console.error(e);
    toast('No he podido leer ese audio. Prueba con WAV o MP3.', 3500);
  }
}

function mixdown(buf) {
  const n = buf.length, ch = buf.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

function buildPeaks(data, bin = 256) {
  const n = Math.ceil(data.length / bin);
  const min = new Float32Array(n), max = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    let lo = 1, hi = -1;
    const end = Math.min(data.length, (b + 1) * bin);
    for (let i = b * bin; i < end; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[b] = lo; max[b] = hi;
  }
  return { min, max, bin };
}

// ---------- regions ----------
const sorted = () => [...state.regions].sort((a, b) => a.start - b.start);
const getSel = () => state.regions.find((r) => r.id === state.sel) || null;

function defaults() {
  const s = getSel();
  return s
    ? { mono: s.mono, speed: s.speed, fadeIn: s.fadeIn, fadeOut: s.fadeOut, normalize: s.normalize, reverse: false }
    : { mono: true, speed: 1, fadeIn: 2, fadeOut: 10, normalize: true, reverse: false };
}

function addRegion(start, end, opts = {}) {
  const dur = state.buffer.duration;
  start = clamp(start, 0, dur); end = clamp(end, 0, dur);
  if (end - start < 0.01) return null;
  const id = state.nextId++;
  const r = { id, start, end, name: '', ...defaults(), ...opts };
  state.regions.push(r);
  renumber();
  return r;
}

// Default names follow time order; user-edited names are kept.
function renumber() {
  sorted().forEach((r, i) => {
    if (!r.custom) r.name = (state.stem + String(i + 1).padStart(2, '0')).slice(0, 8);
  });
}

function deleteRegion(id) {
  state.regions = state.regions.filter((r) => r.id !== id);
  if (state.sel === id) state.sel = null;
  renumber();
  refresh();
}

// ---------- drawing ----------
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
let dpr = 1;

function resize() {
  dpr = window.devicePixelRatio || 1;
  for (const c of [els.wave, els.overview]) {
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
  }
  draw();
}

const tToX = (t) => ((t - state.view.start) / (state.view.end - state.view.start)) * els.wave.width;
const xToT = (x) => state.view.start + (x / els.wave.width) * (state.view.end - state.view.start);

function drawWave(ctx, w, h, from, to, color) {
  const sr = state.buffer.sampleRate;
  const s0 = from * sr, s1 = to * sr;
  const spp = (s1 - s0) / w;
  const { min, max, bin } = state.peaks;
  const data = state.mono;
  const mid = h / 2;
  ctx.fillStyle = color;
  for (let x = 0; x < w; x++) {
    const a = Math.floor(s0 + x * spp), b = Math.max(a + 1, Math.floor(s0 + (x + 1) * spp));
    let lo = 1, hi = -1;
    if (spp >= bin * 2) {
      for (let k = Math.floor(a / bin); k < Math.min(min.length, Math.ceil(b / bin)); k++) {
        if (min[k] < lo) lo = min[k]; if (max[k] > hi) hi = max[k];
      }
    } else {
      for (let i = Math.max(0, a); i < Math.min(data.length, b); i++) {
        const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v;
      }
    }
    if (hi < lo) continue;
    const y1 = mid - hi * mid * 0.95, y2 = mid - lo * mid * 0.95;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

function draw() {
  if (!state.buffer) return;
  const c = els.wave, ctx = c.getContext('2d'), w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  // regions
  const edge = css('--region-edge');
  ctx.font = `${15 * dpr}px VT323, ui-monospace, monospace`;
  sorted().forEach((r, i) => {
    const x1 = tToX(r.start), x2 = tToX(r.end);
    if (x2 < 0 || x1 > w) return;
    const isSel = r.id === state.sel;
    ctx.fillStyle = isSel ? css('--sel') : css('--region');
    ctx.fillRect(x1, 0, x2 - x1, h);
    ctx.fillStyle = isSel ? css('--accent') : edge;
    ctx.fillRect(x1, 0, Math.max(1, dpr * (isSel ? 2 : 1)), h);
    ctx.fillRect(x2 - dpr * (isSel ? 2 : 1), 0, Math.max(1, dpr * (isSel ? 2 : 1)), h);
    if (x2 - x1 > 28 * dpr) ctx.fillText(`${i + 1} ${r.name}`, x1 + 4 * dpr, 14 * dpr);
  });
  // centre line + wave
  ctx.fillStyle = css('--line');
  ctx.fillRect(0, h / 2, w, 1);
  drawWave(ctx, w, h, state.view.start, state.view.end, css('--wave'));
  // cursor
  ctx.fillStyle = css('--muted');
  const cx = tToX(state.cursor);
  if (cx >= 0 && cx <= w) ctx.fillRect(cx, 0, dpr, h);
  // drag preview
  if (drag && drag.mode === 'create') {
    const a = tToX(Math.min(drag.t0, drag.t1)), b = tToX(Math.max(drag.t0, drag.t1));
    ctx.fillStyle = css('--sel');
    ctx.fillRect(a, 0, b - a, h);
  }
  // playhead
  const ph = playheadTime();
  if (ph != null) {
    ctx.fillStyle = css('--accent');
    ctx.fillRect(tToX(ph), 0, 2 * dpr, h);
  }
  drawOverview();
}

function drawOverview() {
  const c = els.overview, ctx = c.getContext('2d'), w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  const dur = state.buffer.duration;
  drawWave(ctx, w, h, 0, dur, css('--muted'));
  ctx.fillStyle = css('--region');
  for (const r of state.regions) ctx.fillRect((r.start / dur) * w, 0, ((r.end - r.start) / dur) * w, h);
  ctx.strokeStyle = css('--accent');
  ctx.lineWidth = 2 * dpr;
  const a = (state.view.start / dur) * w, b = (state.view.end / dur) * w;
  ctx.strokeRect(a + dpr, dpr, Math.max(2, b - a - 2 * dpr), h - 2 * dpr);
}

// ---------- list, meter, inspector ----------
function refresh() {
  renderList();
  renderMeter();
  renderInspector();
  els.exportBtn.disabled = state.regions.length === 0;
  draw();
}

function renderList() {
  const list = sorted();
  els.count.textContent = list.length ? `· ${list.length} en ${Math.ceil(list.length / BANK_SIZE)} banco(s)` : '';
  els.regions.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Aún no hay cortes. Arrastra sobre la onda o usa «Trocear».';
    els.regions.append(li);
    return;
  }
  list.forEach((r, i) => {
    const li = document.createElement('li');
    if (r.id === state.sel) li.classList.add('sel');
    if (i > 0 && i % BANK_SIZE === 0) li.classList.add('newbank');
    const bank = document.createElement('span');
    bank.className = 'bank';
    bank.textContent = `B${Math.floor(i / BANK_SIZE) + 1}·${(i % BANK_SIZE) + 1}`;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = r.name + (r.mono ? '' : ' ⧉') + (r.reverse ? ' ↺' : '') + (r.speed !== 1 ? ` ×${r.speed}` : '');
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = fmtTime((r.end - r.start) / r.speed);
    const play = document.createElement('button');
    play.className = 'play';
    play.title = 'Escuchar';
    play.textContent = '▶';
    play.addEventListener('click', (e) => { e.stopPropagation(); select(r.id); playRegion(r); });
    li.append(bank, nm, dur, play);
    li.addEventListener('click', () => { select(r.id); reveal(r); });
    els.regions.append(li);
  });
}

function renderMeter() {
  const used = state.regions.reduce((a, r) => a + regionCost(r), 0);
  const pct = used / BUDGET_SAMPLES;
  els.memfill.style.width = Math.min(100, pct * 100) + '%';
  els.memfill.classList.toggle('over', pct > 1);
  els.memtext.textContent = `${(used / TARGET_RATE).toFixed(1)} s de ${(BUDGET_SAMPLES / TARGET_RATE).toFixed(1)} s (mono) · ${Math.round(pct * 100)} %${pct > 1 ? ' — no cabe' : ''}`;
}

const P = {
  name: $('pName'), start: $('pStart'), end: $('pEnd'), mono: $('pMono'), speed: $('pSpeed'),
  fadeIn: $('pFadeIn'), fadeOut: $('pFadeOut'), norm: $('pNorm'), rev: $('pRev'),
};

function renderInspector() {
  const r = getSel();
  els.props.hidden = !r;
  els.noSel.hidden = !!r;
  if (!r) return;
  const active = document.activeElement;
  const set = (el, v) => { if (el !== active) el.value = v; };
  set(P.name, r.name);
  set(P.start, r.start.toFixed(3));
  set(P.end, r.end.toFixed(3));
  P.mono.value = r.mono ? '1' : '0';
  P.speed.value = String(r.speed);
  set(P.fadeIn, r.fadeIn);
  set(P.fadeOut, r.fadeOut);
  P.norm.checked = r.normalize;
  P.rev.checked = r.reverse;
  const len = (r.end - r.start) / r.speed;
  els.pInfo.textContent = `Duración final ${fmtTime(len)} · ocupa ${(regionCost(r) / TARGET_RATE).toFixed(2)} s de memoria`;
}

function bindInspector() {
  const upd = (fn) => () => { const r = getSel(); if (!r) return; fn(r); renderList(); renderMeter(); renderInspector(); draw(); };
  P.name.addEventListener('input', upd((r) => { r.name = cleanName(P.name.value); r.custom = true; }));
  P.name.addEventListener('blur', () => renderInspector());
  P.start.addEventListener('change', upd((r) => { const v = +P.start.value; if (v < r.end - 0.01) r.start = clamp(v, 0, r.end - 0.01); }));
  P.end.addEventListener('change', upd((r) => { const v = +P.end.value; if (v > r.start + 0.01) r.end = clamp(v, r.start + 0.01, state.buffer.duration); }));
  P.mono.addEventListener('change', upd((r) => { r.mono = P.mono.value === '1'; }));
  P.speed.addEventListener('change', upd((r) => { r.speed = +P.speed.value; }));
  P.fadeIn.addEventListener('change', upd((r) => { r.fadeIn = clamp(+P.fadeIn.value || 0, 0, 5000); }));
  P.fadeOut.addEventListener('change', upd((r) => { r.fadeOut = clamp(+P.fadeOut.value || 0, 0, 5000); }));
  P.norm.addEventListener('change', upd((r) => { r.normalize = P.norm.checked; }));
  P.rev.addEventListener('change', upd((r) => { r.reverse = P.rev.checked; }));
  $('pPlay').addEventListener('click', () => { const r = getSel(); if (r) playRegion(r); });
  $('pDel').addEventListener('click', () => { if (state.sel) deleteRegion(state.sel); });
  $('pApplyAll').addEventListener('click', () => {
    const s = getSel(); if (!s) return;
    for (const r of state.regions) Object.assign(r, { mono: s.mono, speed: s.speed, fadeIn: s.fadeIn, fadeOut: s.fadeOut, normalize: s.normalize, reverse: s.reverse });
    refresh();
    toast('Ajustes copiados a todos los cortes', 1600);
  });
}

function select(id) {
  state.sel = id;
  refresh();
}

function reveal(r) {
  const span = state.view.end - state.view.start;
  if (r.start < state.view.start || r.end > state.view.end) {
    if (r.end - r.start > span) setView(r.start - 0.05, r.end + 0.05);
    else setView(r.start - span * 0.1, r.start + span * 0.9);
  }
}

// ---------- view ----------
function setView(a, b) {
  const dur = state.buffer.duration;
  let span = clamp(b - a, Math.min(dur, 0.02), dur);
  a = clamp(a, 0, dur - span);
  state.view = { start: a, end: a + span };
  draw();
}
function zoom(factor, centerT) {
  const { start, end } = state.view;
  const c = centerT ?? (start + end) / 2;
  setView(c - (c - start) * factor, c + (end - c) * factor);
}

// ---------- pointer interaction on the waveform ----------
let drag = null;
const EDGE_PX = 7;

function hitTest(x) {
  const px = EDGE_PX * dpr;
  const order = sorted();
  const sel = getSel();
  const cands = sel ? [sel, ...order.filter((r) => r !== sel)] : order;
  for (const r of cands) {
    if (Math.abs(tToX(r.start) - x) < px) return { r, part: 'start' };
    if (Math.abs(tToX(r.end) - x) < px) return { r, part: 'end' };
  }
  for (const r of cands) if (x > tToX(r.start) && x < tToX(r.end)) return { r, part: 'body' };
  return null;
}

function canvasX(e) {
  const rect = els.wave.getBoundingClientRect();
  return (e.clientX - rect.left) * dpr;
}

function bindWave() {
  const c = els.wave;
  c.addEventListener('pointerdown', (e) => {
    if (!state.buffer) return;
    c.setPointerCapture(e.pointerId);
    const x = canvasX(e), t = xToT(x), hit = e.altKey ? null : hitTest(x);
    if (hit && hit.part !== 'body') {
      drag = { mode: 'edge', r: hit.r, part: hit.part };
      state.sel = hit.r.id;
    } else if (hit) {
      drag = { mode: 'move', r: hit.r, t0: t, s0: hit.r.start, e0: hit.r.end, x0: x, moved: false };
      state.sel = hit.r.id;
    } else {
      drag = { mode: 'create', t0: t, t1: t, x0: x };
    }
    refresh();
  });
  c.addEventListener('pointermove', (e) => {
    if (!state.buffer) return;
    const x = canvasX(e), t = clamp(xToT(x), 0, state.buffer.duration);
    if (!drag) {
      const hit = hitTest(x);
      c.style.cursor = hit ? (hit.part === 'body' ? 'grab' : 'ew-resize') : 'crosshair';
      return;
    }
    if (drag.mode === 'create') { drag.t1 = t; draw(); }
    else if (drag.mode === 'edge') {
      const r = drag.r;
      if (drag.part === 'start') r.start = Math.min(t, r.end - 0.01);
      else r.end = Math.max(t, r.start + 0.01);
      renderInspector(); renderMeter(); draw();
    } else if (drag.mode === 'move') {
      if (Math.abs(x - drag.x0) > 3 * dpr) drag.moved = true;
      if (!drag.moved) return;
      const len = drag.e0 - drag.s0;
      const s = clamp(drag.s0 + (t - drag.t0), 0, state.buffer.duration - len);
      drag.r.start = s; drag.r.end = s + len;
      renderInspector(); draw();
    }
  });
  const end = (e) => {
    if (!drag) return;
    const x = canvasX(e);
    if (drag.mode === 'create') {
      if (Math.abs(x - drag.x0) < 4 * dpr) {
        state.cursor = drag.t0;
        state.sel = null;
      } else {
        const r = addRegion(Math.min(drag.t0, drag.t1), Math.max(drag.t0, drag.t1));
        if (r) state.sel = r.id;
      }
    } else if (drag.mode === 'move' && !drag.moved) {
      state.cursor = xToT(x);
    }
    if (drag.mode !== 'create') renumber();
    drag = null;
    refresh();
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('wheel', (e) => {
    if (!state.buffer) return;
    e.preventDefault();
    const span = state.view.end - state.view.start;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (e.shiftKey ? e.deltaY : e.deltaX) || e.deltaY;
      setView(state.view.start + (d / 500) * span, state.view.end + (d / 500) * span);
    } else {
      zoom(Math.exp(e.deltaY * 0.0025), xToT(canvasX(e)));
    }
  }, { passive: false });

  const ov = els.overview;
  const ovSet = (e) => {
    const rect = ov.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * state.buffer.duration;
    const span = state.view.end - state.view.start;
    setView(t - span / 2, t + span / 2);
  };
  ov.addEventListener('pointerdown', (e) => { if (!state.buffer) return; ov.setPointerCapture(e.pointerId); ovSet(e); ov.onpointermove = ovSet; });
  ov.addEventListener('pointerup', () => { ov.onpointermove = null; });
}

// ---------- audio ----------
async function renderRegion(r) {
  const buf = state.buffer, sr = buf.sampleRate;
  const s0 = Math.floor(r.start * sr), s1 = Math.min(buf.length, Math.ceil(r.end * sr));
  const n = Math.max(1, s1 - s0);
  const outCh = r.mono ? 1 : 2;
  const outLen = Math.max(1, Math.ceil((n / sr / r.speed) * TARGET_RATE));
  const off = new OfflineAudioContext(outCh, outLen, TARGET_RATE);
  const slice = off.createBuffer(buf.numberOfChannels, n, sr);
  for (let c = 0; c < buf.numberOfChannels; c++) slice.copyToChannel(buf.getChannelData(c).subarray(s0, s1), c);
  const src = off.createBufferSource();
  src.buffer = slice;
  src.playbackRate.value = r.speed;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  const chans = [];
  for (let c = 0; c < outCh; c++) chans.push(new Float32Array(out.getChannelData(c)));
  return finish(chans, { reverse: r.reverse, normalize: r.normalize, fadeInMs: r.fadeIn, fadeOutMs: r.fadeOut });
}

function stop() {
  if (playing) { try { playing.src.stop(); } catch {} playing = null; }
}

async function playRegion(r) {
  stop();
  const ctx = audio();
  await ctx.resume();
  const chans = await renderRegion(r);
  const b = ctx.createBuffer(chans.length, chans[0].length, TARGET_RATE);
  chans.forEach((d, i) => b.copyToChannel(d, i));
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.connect(ctx.destination);
  src.start();
  playing = { src, t0: ctx.currentTime, from: r.start, to: r.end, rate: r.speed, reverse: r.reverse };
  src.onended = () => { if (playing && playing.src === src) playing = null; draw(); };
  tick();
}

async function playOriginal() {
  stop();
  const ctx = audio();
  await ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = state.buffer;
  src.connect(ctx.destination);
  src.start(0, state.cursor);
  playing = { src, t0: ctx.currentTime, from: state.cursor, to: state.buffer.duration, rate: 1, reverse: false };
  src.onended = () => { if (playing && playing.src === src) playing = null; draw(); };
  tick();
}

function playheadTime() {
  if (!playing || !actx) return null;
  const el = (actx.currentTime - playing.t0) * playing.rate;
  const t = playing.reverse ? playing.to - el : playing.from + el;
  return clamp(t, playing.from, playing.to);
}

function tick() {
  draw();
  if (playing) requestAnimationFrame(tick);
}

// ---------- auto chop ----------
function autoChop() {
  const sel = getSel();
  const from = sel ? sel.start : 0;
  const to = sel ? sel.end : state.buffer.duration;
  let ranges;
  if (els.automode.value === 'equal') {
    ranges = equalRanges(from, to, +els.parts.value || 8);
  } else {
    const sr = state.buffer.sampleRate;
    const data = state.mono.subarray(Math.floor(from * sr), Math.ceil(to * sr));
    const on = detectOnsets(data, sr, +els.sens.value).map((t) => t + from);
    ranges = onsetsToRanges(on, to, 4);
  }
  if (sel) state.regions = state.regions.filter((r) => r.id !== sel.id);
  const base = sel ? { mono: sel.mono, speed: sel.speed, fadeIn: sel.fadeIn, fadeOut: sel.fadeOut, normalize: sel.normalize } : {};
  state.sel = null;
  let first = null;
  for (const [a, b] of ranges) { const r = addRegion(a, b, base); if (r && !first) first = r; }
  if (first) state.sel = first.id;
  refresh();
  toast(`${ranges.length} cortes ${sel ? 'dentro del corte seleccionado' : 'en todo el audio'}`, 1800);
}

// ---------- export ----------
async function exportZip() {
  const list = sorted();
  if (!list.length) return;
  const used = list.reduce((a, r) => a + regionCost(r), 0);
  if (used > BUDGET_SAMPLES && !confirm('Los cortes no caben en la memoria del Wave Bard. La web app de Bastl te dejará bajar la calidad para que quepan. ¿Exportar igualmente?')) return;
  els.exportBtn.disabled = true;
  try {
    const names = uniqueNames(list.map((r) => r.name));
    const files = [];
    for (let i = 0; i < list.length; i++) {
      toast(`Procesando ${i + 1}/${list.length}…`);
      const chans = await renderRegion(list[i]);
      const bank = Math.floor(i / BANK_SIZE) + 1;
      files.push({ name: `${state.stem.toLowerCase()}-chochop/banco${bank}/${names[i]}.wav`, data: encodeWav(chans) });
    }
    const blob = new Blob([makeZip(files)], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.stem.toLowerCase()}-chochop.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`ZIP listo: ${files.length} samples en ${Math.ceil(files.length / BANK_SIZE)} banco(s)`, 2500);
  } catch (e) {
    console.error(e);
    toast('Algo falló al exportar. Mira la consola.', 3500);
  } finally {
    els.exportBtn.disabled = false;
  }
}

// ---------- misc ----------
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
let toastTimer = null;
function toast(msg, ms) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { els.toast.hidden = true; }

function bindGlobal() {
  els.file.addEventListener('change', () => { const f = els.file.files[0]; if (f) loadFile(f); els.file.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('over'); }));
  document.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f); });

  $('zoomin').addEventListener('click', () => zoom(0.5));
  $('zoomout').addEventListener('click', () => zoom(2));
  $('zoomall').addEventListener('click', () => setView(0, state.buffer.duration));
  $('zoomsel').addEventListener('click', () => { const r = getSel(); if (r) { const pad = (r.end - r.start) * 0.1; setView(r.start - pad, r.end + pad); } });
  $('playall').addEventListener('click', playOriginal);
  $('stop').addEventListener('click', () => { stop(); draw(); });
  $('autochop').addEventListener('click', autoChop);
  $('clear').addEventListener('click', () => {
    if (state.regions.length && confirm('¿Borrar todos los cortes?')) { state.regions = []; state.sel = null; refresh(); }
  });
  els.automode.addEventListener('change', () => {
    const eq = els.automode.value === 'equal';
    els.partsWrap.hidden = !eq; els.sensWrap.hidden = eq;
  });
  els.exportBtn.addEventListener('click', exportZip);

  document.addEventListener('keydown', (e) => {
    if (!state.buffer) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (playing) { stop(); draw(); return; }
      const r = getSel();
      r ? playRegion(r) : playOriginal();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) {
      e.preventDefault();
      deleteRegion(state.sel);
    } else if (e.key === 'Escape') {
      state.sel = null; refresh();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const list = sorted();
      if (!list.length) return;
      const i = list.findIndex((r) => r.id === state.sel);
      const j = clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, list.length - 1);
      select(list.at(i < 0 ? 0 : j).id);
      reveal(getSel());
    }
  });
  window.addEventListener('resize', resize);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', draw);
}

bindGlobal();
bindWave();
bindInspector();
