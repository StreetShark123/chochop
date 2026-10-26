import {
  TARGET_RATE, cleanName, uniqueNames,
  detectOnsets, beatGrid, digRanges, bitsToPoints, anomalyRanges, finish, encodeWav, makeZip, fmtTime,
} from './dsp.js';
import { t, applyI18n, setLang, onLangChange, getLang } from './i18n.js';

const $ = (id) => document.getElementById(id);

// Icons come from the SVG sprite in index.html.
const SVG = 'http://www.w3.org/2000/svg';
function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// Numbers follow the interface language (decimal comma in es/gl).
const dec = (s) => (getLang() === 'en' ? s : s.replace('.', ','));
const fmtT = (s) => dec(fmtTime(s));
const els = {
  file: $('file'), wavewrap: $('wavewrap'), fname: $('fname'), fmeta: $('fmeta'),
  wave: $('wave'), overview: $('overview'), regions: $('regions'), count: $('count'),
  memtext: $('memtext'), exportBtn: $('export'), exportInfo: $('exportInfo'), pack: $('pack'), qGo: $('qGo'), pStar: $('pStar'), selName: $('selName'), selWave: $('selWave'), clock: $('clock'), toast: $('toast'),
  props: $('props'), noSel: $('noSel'), pInfo: $('pInfo'),
  recmenu: $('recmenu'), recbar: $('recbar'), recLabel: $('recLabel'), recTime: $('recTime'),
  recLevel: $('recLevel'), recHint: $('recHint'),
  digN: $('digN'), digLen: $('digLen'),
};

const state = {
  buffer: null,      // decoded AudioBuffer
  mono: null,        // Float32Array mixdown for display / analysis
  peaks: null,       // {min, max, bin}
  stem: 'SMP',
  pack: '',          // pack name: ZIP + folder name, and stem for auto sample names
  regions: [],       // {id, start, end, name, mono, speed, fadeIn, fadeOut, lvl, reverse, keep, custom}
  sel: null,
  view: { start: 0, end: 1 },
  cursor: 0,
  nextId: 1,
  bufId: 0,          // bumps on every new buffer; keys the cached waveform layers
  bankSize: 8,       // slots per bank (8 / 12 / 16)
};

// Pads: slots of the active bank map to a 4×4 block of physical keys.
const PAD_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyQ', 'KeyW', 'KeyE', 'KeyR',
  'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyZ', 'KeyX', 'KeyC', 'KeyV'];
const PAD_LABELS = '1234QWERASDFZXCV';
const BANK_KEY = 'chochop.bank';

let actx = null;
let playing = null; // {src, t0, from, to, rate, reverse}
const audio = () => (actx ||= new AudioContext());

// ---------- loading ----------
async function loadFile(file) {
  try {
    toast(t('decoding'));
    const ab = await file.arrayBuffer();
    const buf = await audio().decodeAudioData(ab);
    const replacing = !!state.buffer;
    setBuffer(buf, file.name);
    if (replacing) toast(file.name, 3000, undoAction()); else hideToast();
  } catch (e) {
    console.error(e);
    toast(t('readFail'), 3500);
  }
}

function setBuffer(buf, name) {
  if (state.buffer) snapshot();
  stop();
  state.buffer = buf;
  state.bufId++;
  state.mono = mixdown(buf);
  state.peaks = buildPeaks(state.mono);
  setPack(name.replace(/\.[^.]+$/, ''));
  state.regions = [];
  state.sel = null;
  state.cursor = 0;
  state.view = { start: 0, end: buf.duration };
  els.fname.textContent = name;
  renderMeta();
  els.fname.removeAttribute('data-i18n');
  setReady(true);
  resize();
  refresh();
}

// One level of undo for anything that replaces audio or slices (load, record, crop, dig,
// remove, start over, copy to all). Cheap: buffers are shared, slices are copied.
let undoSnap = null;
function snapshot() {
  undoSnap = {
    buffer: state.buffer, mono: state.mono, peaks: state.peaks, fname: els.fname.textContent,
    regions: state.regions.map((r) => ({ ...r })), sel: state.sel, pack: state.pack,
    view: { ...state.view }, cursor: state.cursor,
  };
}
function undo() {
  const s = undoSnap;
  if (!s) return;
  undoSnap = null;
  stop();
  if (s.buffer !== state.buffer) {
    Object.assign(state, { buffer: s.buffer, mono: s.mono, peaks: s.peaks });
    state.bufId++;
    els.fname.textContent = s.fname;
    renderMeta();
  }
  Object.assign(state, { regions: s.regions, sel: s.sel, view: s.view, cursor: s.cursor });
  setPack(s.pack);
  resize();
  refresh();
  toast(t('undone'), 1500);
}
const undoAction = () => ({ label: t('undo'), run: undo });

// Before any audio is loaded the editor is visible but its controls are off.
function setReady(on) {
  document.body.classList.toggle('noaudio', !on);
  document.querySelectorAll('#editor button, #editor input, #editor select').forEach((el) => {
    if (el.id !== 'export' && el.name !== 'bank') el.disabled = !on;
  });
}

function renderMeta() {
  const buf = state.buffer;
  if (!buf) return;
  els.fmeta.textContent = `${fmtT(buf.duration)} · ${t(buf.numberOfChannels === 1 ? 'monoL' : 'stereoL')} · ${buf.sampleRate} Hz`;
}

// The pack name names the ZIP and its folder, and seeds auto sample names
// (first 5 valid characters). Hand-edited sample names are kept.
const packSlug = () => (state.pack.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'chop-chop');
function setPack(name) {
  state.pack = String(name).slice(0, 40);
  state.stem = cleanName(state.pack).slice(0, 5) || 'SMP';
  if (els.pack.value !== state.pack) els.pack.value = state.pack;
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
    ? { mono: s.mono, speed: s.speed, fadeIn: s.fadeIn, fadeOut: s.fadeOut, lvl: s.lvl, reverse: false }
    : { mono: true, speed: 1, fadeIn: 2, fadeOut: 10, lvl: 'loud', reverse: false };
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
  snapshot();
  state.regions = state.regions.filter((r) => r.id !== id);
  if (state.sel === id) state.sel = null;
  renumber();
  refresh();
  toast(t('removed'), 3000, undoAction());
}

// Dig length: changing it resizes every chop that isn't starred.
const digLen = () => clamp(+els.digLen.value || 2, 0.05, 30);
function applyDigLen() {
  if (!state.buffer || !(+els.digLen.value > 0)) return;
  const L = digLen(), dur = state.buffer.duration;
  for (const r of state.regions) {
    if (r.keep) continue;
    r.start = Math.min(r.start, Math.max(0, dur - L));
    r.end = Math.min(dur, r.start + L);
  }
  refresh();
}

function toggleKeep(r) {
  r.keep = !r.keep;
  refresh();
}

// ---------- drawing ----------
// Theme colours are read from CSS once; the theme is fixed (dark only).
let C = null;
const colors = () => (C ||= Object.fromEntries(
  ['region-edge', 'sel', 'region', 'accent', 'line', 'wave', 'muted']
    .map((v) => [v, getComputedStyle(document.documentElement).getPropertyValue(`--${v}`).trim()]),
));

// Waveform bitmaps are cached and only repainted when the audio, size or view changes,
// so the playhead animation just composites them.
const layers = { wave: { key: '' }, over: { key: '' } };
function layer(l, w, h, key, paint) {
  if (l.key !== key) {
    l.c ||= document.createElement('canvas');
    l.c.width = w; l.c.height = h;
    paint(l.c.getContext('2d'));
    l.key = key;
  }
  return l.c;
}

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

// px > 1 draws chunky pixel columns, snapped to a px grid vertically too.
function drawWave(ctx, w, h, from, to, color, px = 1) {
  const sr = state.buffer.sampleRate;
  const s0 = from * sr, s1 = to * sr;
  const spp = (s1 - s0) / w;
  const { min, max, bin } = state.peaks;
  const data = state.mono;
  const mid = h / 2;
  ctx.fillStyle = color;
  const bar = px > 2 ? px - 1 : px;
  for (let x = 0; x < w; x += px) {
    const a = Math.floor(s0 + x * spp), b = Math.max(a + 1, Math.floor(s0 + (x + px) * spp));
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
    let y1 = mid - hi * mid * 0.92, y2 = mid - lo * mid * 0.92;
    if (px > 1) { y1 = Math.floor(y1 / px) * px; y2 = Math.ceil(y2 / px) * px; }
    ctx.fillRect(x, y1, bar, Math.max(px, y2 - y1));
  }
}

function draw() {
  if (!state.buffer) return;
  const c = els.wave, ctx = c.getContext('2d'), w = c.width, h = c.height, k = colors();
  const { start, end } = state.view;
  ctx.clearRect(0, 0, w, h);
  // regions
  const edge = k['region-edge'];
  ctx.font = `${8 * dpr}px Silkscreen, ui-monospace, monospace`;
  sorted().forEach((r, i) => {
    const x1 = tToX(r.start), x2 = tToX(r.end);
    if (x2 < 0 || x1 > w) return;
    const isSel = r.id === state.sel;
    ctx.fillStyle = isSel ? k.sel : k.region;
    ctx.fillRect(x1, 0, x2 - x1, h);
    ctx.fillStyle = isSel ? k.accent : edge;
    ctx.fillRect(x1, 0, Math.max(1, dpr * (isSel ? 2 : 1)), h);
    ctx.fillRect(x2 - dpr * (isSel ? 2 : 1), 0, Math.max(1, dpr * (isSel ? 2 : 1)), h);
    if (x2 - x1 > 28 * dpr) ctx.fillText(`${i + 1} ${r.name}${r.keep ? ' *' : ''}`, x1 + 5 * dpr, 13 * dpr);
  });
  // centre line + wave
  ctx.fillStyle = k.line;
  ctx.fillRect(0, h / 2, w, 1);
  ctx.drawImage(layer(layers.wave, w, h, `${state.bufId}:${w}x${h}:${start}:${end}`,
    (g) => drawWave(g, w, h, start, end, k.wave, Math.max(1, Math.round(2 * dpr)))), 0, 0);
  // cursor
  ctx.fillStyle = k.muted;
  const cx = tToX(state.cursor);
  if (cx >= 0 && cx <= w) ctx.fillRect(cx, 0, dpr, h);
  // drag preview
  if (drag && drag.mode === 'create') {
    const a = tToX(Math.min(drag.t0, drag.t1)), b = tToX(Math.max(drag.t0, drag.t1));
    ctx.fillStyle = k.sel;
    ctx.fillRect(a, 0, b - a, h);
  }
  // playhead
  const ph = playheadTime();
  setClock(fmtClockFine(ph ?? state.cursor));
  if (ph != null) {
    ctx.fillStyle = k.accent;
    ctx.fillRect(tToX(ph), 0, 2 * dpr, h);
  }
  drawOverview();
}

function drawOverview() {
  const c = els.overview, ctx = c.getContext('2d'), w = c.width, h = c.height, k = colors();
  const dur = state.buffer.duration;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(layer(layers.over, w, h, `${state.bufId}:${w}x${h}`, (g) => drawWave(g, w, h, 0, dur, k.muted)), 0, 0);
  ctx.fillStyle = k.region;
  for (const r of state.regions) ctx.fillRect((r.start / dur) * w, 0, ((r.end - r.start) / dur) * w, h);
  ctx.strokeStyle = k.accent;
  ctx.lineWidth = 2 * dpr;
  const a = (state.view.start / dur) * w, b = (state.view.end / dur) * w;
  ctx.strokeRect(a + dpr, dpr, Math.max(2, b - a - 2 * dpr), h - 2 * dpr);
}

// ---------- list, meter, inspector ----------
function refresh() {
  for (const id of rendered.keys()) if (!state.regions.some((r) => r.id === id)) rendered.delete(id);
  warmSoon();
  renderList();
  renderMeter();
  renderInspector();
  els.exportBtn.disabled = state.regions.length === 0;
  draw();
}

function renderList() {
  const list = sorted();
  const nb = Math.ceil(list.length / state.bankSize);
  els.count.textContent = list.length ? t('count', { n: list.length, b: nb, banks: t('bank', { n: nb }) }) : '';
  const refocus = els.regions.contains(document.activeElement); // keep keyboard focus across re-renders
  const bs = state.bankSize, active = activeBank();
  els.regions.dataset.bank = bs;
  els.regions.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'muted empty';
    li.textContent = t(state.buffer ? 'emptyList' : 'emptyNoAudio');
    els.regions.append(li);
  }
  const thumbs = [];
  list.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = 'slot';
    li.dataset.id = r.id;
    li.classList.toggle('sel', r.id === state.sel);
    li.classList.toggle('kept', !!r.keep);
    li.tabIndex = 0;
    const thumb = document.createElement('canvas');
    thumb.className = 'thumb';
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = `${Math.floor(i / state.bankSize) + 1}·${(i % state.bankSize) + 1}`;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = r.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [fmtT((r.end - r.start) / r.speed), !r.mono && 'ST', r.reverse && 'REV', r.speed !== 1 && dec(`×${r.speed}`)]
      .filter(Boolean).join(' · ');
    const key = document.createElement('span');
    key.className = 'key';
    if (Math.floor(i / bs) === active) key.textContent = PAD_LABELS[i % bs];
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'iconbtn star' + (r.keep ? ' on' : '');
    star.title = t(r.keep ? 'starOn' : 'starOff');
    star.setAttribute('aria-label', star.title);
    star.setAttribute('aria-pressed', String(!!r.keep));
    star.append(icon(r.keep ? 'star-f' : 'star'));
    star.addEventListener('click', (e) => { e.stopPropagation(); toggleKeep(r); });
    li.setAttribute('aria-label', `${t('listen')} ${r.name}`);
    li.append(thumb, idx, key, star, nm, meta);
    // Slots are pads: pressing one plays it straight away (on press, not release).
    li.addEventListener('pointerdown', (e) => { if (e.button === 0 && !e.target.closest('button')) hit(r); });
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === li) hit(r); });
    els.regions.append(li);
    thumbs.push([thumb, r]);
  });
  // Free slots up to the end of the last bank, so bank capacity is visible at a glance.
  for (let i = list.length; i < Math.max(1, nb) * state.bankSize; i++) {
    const li = document.createElement('li');
    li.className = 'slot free';
    li.setAttribute('aria-hidden', 'true');
    els.regions.append(li);
  }
  if (state.buffer) {
    const k = colors();
    for (const [c, r] of thumbs) paintSlice(c, r, r.id === state.sel ? k.accent : k.wave);
  }
  if (refocus) els.regions.querySelector('li.sel')?.focus();
}

const activeBank = () => {
  const i = sorted().findIndex((r) => r.id === state.sel);
  return i < 0 ? 0 : Math.floor(i / state.bankSize);
};

// Play a slice like a pad: select it, flash its slot, retrigger from the start.
function hit(r) {
  if (state.sel !== r.id) {
    const bank = activeBank();
    state.sel = r.id;
    if (activeBank() === bank) selectLight(); else refresh(); // key labels move with the bank
  }
  playRegion(r);
  const li = els.regions.querySelector(`li[data-id="${r.id}"]`);
  if (li) { li.classList.remove('hit'); void li.offsetWidth; li.classList.add('hit'); }
}

// Cheap selection change for fast pad playing: restyle the two affected slots only.
function selectLight() {
  const k = colors();
  for (const li of els.regions.querySelectorAll('li.slot[data-id]')) {
    const on = +li.dataset.id === state.sel;
    if (li.classList.contains('sel') === on) continue;
    li.classList.toggle('sel', on);
    const r = state.regions.find((x) => x.id === +li.dataset.id);
    if (r) paintSlice(li.querySelector('canvas'), r, on ? k.accent : k.wave);
  }
  renderInspector();
  draw();
}

// Keep only the selected slice's stretch of the audio; the rest (and every slice) is dropped.
function cropToSel() {
  const r = getSel();
  if (!r) return;
  const src = state.buffer, sr = src.sampleRate;
  const a = Math.floor(r.start * sr), b = Math.min(src.length, Math.ceil(r.end * sr));
  const buf = audio().createBuffer(src.numberOfChannels, Math.max(1, b - a), sr);
  for (let c = 0; c < src.numberOfChannels; c++) buf.copyToChannel(src.getChannelData(c).subarray(a, b), c);
  const pack = state.pack;
  setBuffer(buf, els.fname.textContent);
  setPack(pack); // cropping shouldn't rename the pack
  toast(t('cropDone', { d: fmtT(buf.duration) }), 4000, undoAction());
}

function setBankSize(n) {
  const old = state.bankSize;
  state.bankSize = [8, 12, 16].includes(n) ? n : 8;
  try { localStorage.setItem(BANK_KEY, String(state.bankSize)); } catch {}
  document.querySelector(`input[name=bank][value="${state.bankSize}"]`).checked = true;
  if (+els.digN.value === old) els.digN.value = state.bankSize; // keep "one bank" digs in step
  refresh();
}

// Draw one slice's waveform into a small canvas sized to its box.
function paintSlice(c, r, color) {
  const w = (c.width = Math.max(1, Math.round(c.clientWidth * dpr)));
  const h = (c.height = Math.max(1, Math.round(c.clientHeight * dpr)));
  drawWave(c.getContext('2d'), w, h, r.start, r.end, color, Math.max(1, Math.round(2 * dpr)));
}

function renderMeter() {
  const total = state.regions.reduce((a, r) => a + (r.end - r.start) / r.speed, 0);
  els.memtext.textContent = `Total ${dec(total.toFixed(1))} s`;
  const n = state.regions.length;
  const nb = Math.ceil(n / state.bankSize);
  els.exportInfo.textContent = n
    ? t('exportInfo', { n, slices: t('nslice', { n }), b: nb, banks: t('bank', { n: nb }) })
    : t('exportEmpty');
}

const P = {
  name: $('pName'), start: $('pStart'), end: $('pEnd'), mono: $('pMono'), speed: $('pSpeed'),
  fadeIn: $('pFadeIn'), fadeOut: $('pFadeOut'), lvl: $('pLevel'), rev: $('pRev'),
};

function renderInspector() {
  const r = getSel();
  els.props.hidden = !r;
  els.noSel.hidden = !!r;
  els.pStar.hidden = !r;
  els.selName.textContent = r ? r.name : '';
  els.selWave.parentElement.classList.toggle('on', !!r);
  if (!r) return;
  paintSlice(els.selWave, r, colors().accent);
  els.pStar.classList.toggle('on', !!r.keep);
  els.pStar.title = t(r.keep ? 'starOn' : 'starOff');
  els.pStar.setAttribute('aria-label', els.pStar.title);
  els.pStar.setAttribute('aria-pressed', String(!!r.keep));
  els.pStar.querySelector('use').setAttribute('href', r.keep ? '#i-star-f' : '#i-star');
  const active = document.activeElement;
  const set = (el, v) => { if (el !== active) el.value = v; };
  set(P.name, r.name);
  set(P.start, r.start.toFixed(3));
  set(P.end, r.end.toFixed(3));
  P.mono.value = r.mono ? '1' : '0';
  P.speed.value = String(r.speed);
  set(P.fadeIn, r.fadeIn);
  set(P.fadeOut, r.fadeOut);
  P.lvl.value = r.lvl;
  P.rev.checked = r.reverse;
  const len = (r.end - r.start) / r.speed;
  els.pInfo.textContent = t('pInfo', { d: fmtT(len) }) + (r.speed > 1 ? ` · ${t('speedHint')}` : '');
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
  P.lvl.addEventListener('change', upd((r) => { r.lvl = P.lvl.value; }));
  P.rev.addEventListener('change', upd((r) => { r.reverse = P.rev.checked; }));
  $('pPlay').addEventListener('click', () => { const r = getSel(); if (r) playRegion(r); });
  els.pStar.addEventListener('click', () => { const r = getSel(); if (r) toggleKeep(r); });
  $('pDel').addEventListener('click', () => { if (state.sel) deleteRegion(state.sel); });
  $('pCrop').addEventListener('click', cropToSel);
  $('pApplyAll').addEventListener('click', () => {
    const s = getSel(); if (!s) return;
    snapshot();
    for (const r of state.regions) Object.assign(r, { mono: s.mono, speed: s.speed, fadeIn: s.fadeIn, fadeOut: s.fadeOut, lvl: s.lvl, reverse: s.reverse });
    refresh();
    toast(t('copied'), 3000, undoAction());
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
    try { c.setPointerCapture(e.pointerId); } catch {}
    const x = canvasX(e), time = xToT(x), hit = e.altKey ? null : hitTest(x);
    if (hit && hit.part !== 'body') {
      drag = { mode: 'edge', r: hit.r, part: hit.part };
      state.sel = hit.r.id;
    } else if (hit) {
      drag = { mode: 'move', r: hit.r, t0: time, s0: hit.r.start, e0: hit.r.end, x0: x, moved: false };
      state.sel = hit.r.id;
    } else {
      drag = { mode: 'create', t0: time, t1: time, x0: x };
    }
    refresh();
  });
  c.addEventListener('pointermove', (e) => {
    if (!state.buffer) return;
    const x = canvasX(e), time = clamp(xToT(x), 0, state.buffer.duration);
    if (!drag) {
      const hit = hitTest(x);
      c.style.cursor = hit ? (hit.part === 'body' ? 'grab' : 'ew-resize') : 'crosshair';
      return;
    }
    if (drag.mode === 'create') { drag.t1 = time; draw(); }
    else if (drag.mode === 'edge') {
      const r = drag.r;
      if (drag.part === 'start') r.start = Math.min(time, r.end - 0.01);
      else r.end = Math.max(time, r.start + 0.01);
      renderInspector(); renderMeter(); draw();
    } else if (drag.mode === 'move') {
      if (Math.abs(x - drag.x0) > 3 * dpr) drag.moved = true;
      if (!drag.moved) return;
      const len = drag.e0 - drag.s0;
      const s = clamp(drag.s0 + (time - drag.t0), 0, state.buffer.duration - len);
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
  c.addEventListener('dblclick', (e) => {
    if (!state.buffer || hitTest(canvasX(e))) return;
    const L = digLen();
    const s = clamp(xToT(canvasX(e)), 0, Math.max(0, state.buffer.duration - L));
    const r = addRegion(s, s + L);
    if (r) { state.sel = r.id; refresh(); }
  });
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
    const mid = ((e.clientX - rect.left) / rect.width) * state.buffer.duration;
    const span = state.view.end - state.view.start;
    setView(mid - span / 2, mid + span / 2);
  };
  ov.addEventListener('pointerdown', (e) => { if (!state.buffer) return; try { ov.setPointerCapture(e.pointerId); } catch {} ovSet(e); ov.onpointermove = ovSet; });
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
  return finish(chans, { reverse: r.reverse, lvl: r.lvl, fadeInMs: r.fadeIn, fadeOutMs: r.fadeOut });
}

// Processed chops are cached per region until any of their settings change;
// refresh() drops entries for regions that no longer exist.
const rendered = new Map();
async function renderedBuffer(r) {
  const key = [r.start, r.end, r.mono, r.speed, r.fadeIn, r.fadeOut, r.lvl, r.reverse].join();
  const hit = rendered.get(r.id);
  if (hit && hit.key === key) return hit.buf;
  const chans = await renderRegion(r);
  const buf = audio().createBuffer(chans.length, chans[0].length, TARGET_RATE);
  chans.forEach((d, i) => buf.copyToChannel(d, i));
  rendered.set(r.id, { key, buf });
  return buf;
}

// Every stop() starts a new generation, so playback that was still preparing
// (rendering or resuming the context) when the user stopped never starts.
let playGen = 0;
// Render slices in the background after edits, so pads respond without a delay.
let warmTimer = 0;
function warmSoon() {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(async () => {
    for (const r of sorted()) {
      if (!state.regions.includes(r)) continue;
      try { await renderedBuffer(r); } catch { return; }
    }
  }, 250);
}

function stop() {
  playGen++;
  if (playing) { try { playing.src.stop(); } catch {} playing = null; }
}

async function playRegion(r) {
  stop();
  const gen = playGen, ctx = audio();
  await ctx.resume();
  const b = await renderedBuffer(r);
  if (gen !== playGen) return;
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
  const gen = playGen, ctx = audio();
  await ctx.resume();
  if (gen !== playGen) return;
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

let raf = 0;
function tick() {
  if (raf) return;
  const loop = () => { draw(); raf = playing ? requestAnimationFrame(loop) : 0; };
  loop();
}

// ---------- dig ----------
const digMode = () => document.querySelector('input[name=dig]:checked').value;
let onsetCache = null;

// What a dig needs: how many new slices, their length, the starred ones to keep, the hits.
function digPlan() {
  if (!state.buffer) return null;
  const n = clamp(Math.round(+els.digN.value || 8), 1, 64), L = digLen(), dur = state.buffer.duration;
  const kept = state.regions.filter((r) => r.keep);
  const want = n - kept.length;
  if (want <= 0) { toast(t('allKept', { n: kept.length }), 2500); return null; }
  if (onsetCache?.buffer !== state.buffer) {
    const sr = state.buffer.sampleRate;
    onsetCache = { buffer: state.buffer, onsets: detectOnsets(state.mono, sr, 5), grid: beatGrid(state.mono, sr) };
  }
  return { want, L, dur, kept, onsets: onsetCache.onsets, grid: onsetCache.grid, taken: kept.map((r) => [r.start, r.end]) };
}

function placeDig(plan, ranges) {
  snapshot();
  const base = defaults();
  stop();
  state.regions = [...plan.kept];
  for (const [a, b] of ranges) addRegion(a, b, base);
  state.sel = sorted()[0]?.id ?? null; // so the slice card and pad keys are live right away
  refresh();
}

function dig() {
  if (!state.buffer) return;
  if (digMode() === 'quantum') { openQuantum(); return; }
  const plan = digPlan();
  if (!plan) return;
  const mode = digMode(), grid = mode === 'spread' ? plan.grid : null;
  // Spread follows the song: slices start on bar lines and last a whole number of beats.
  if (grid) plan.L = Math.max(1, Math.round(plan.L / grid.beat)) * grid.beat;
  const ranges = digRanges({
    onsets: plan.onsets, grid, dur: plan.dur, n: plan.want, len: plan.L, mode, from: state.cursor, taken: plan.taken,
  });
  placeDig(plan, ranges);
  const msg = plan.kept.length ? t('dugKept', { n: ranges.length, k: plan.kept.length }) : t('dug', { n: ranges.length, d: fmtT(plan.L) });
  toast(grid ? `${msg} · ${Math.round(grid.bpm)} BPM` : msg, 3000, undoAction());
}

// ---------- sigil dig ----------
// A playful ritual: a sigil drawn by hand seeds 1024 random points over the audio, and Dig
// takes the windows where they cluster most. The randomness is the sub-pixel, sub-millisecond
// jitter of the strokes, hashed with SHA-256.
const Q_POINTS = 1024, Q_BITS = Q_POINTS * 16;
const SIGIL_MS = 6000; // ritual time from the first stroke; draw as much as you like meanwhile
const sigil = { pts: [], drawing: false, t0: 0, raf: 0 };

function openQuantum() {
  if (!state.buffer || rec) return;
  $('quantum').showModal();
  const c = $('sigil'), r = c.getBoundingClientRect();
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  clearSigil();
}

function clearSigil() {
  cancelAnimationFrame(sigil.raf);
  sigil.pts = []; sigil.t0 = 0; sigil.raf = 0;
  els.qGo.hidden = true;
  $('sigilFill').style.width = '0';
  redrawSigil();
}

// The bar fills with time once drawing starts; when it's full, "Read" appears.
function sigilTimer() {
  const p = Math.min(1, (performance.now() - sigil.t0) / SIGIL_MS);
  $('sigilFill').style.width = p * 100 + '%';
  if (p < 1) sigil.raf = requestAnimationFrame(sigilTimer);
  else { sigil.raf = 0; els.qGo.hidden = false; }
}

function redrawSigil() {
  const c = $('sigil'), ctx = c.getContext('2d'), k = colors();
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.lineWidth = 2.5 * dpr; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = k.wave; ctx.shadowColor = k.wave; ctx.shadowBlur = 8 * dpr;
  ctx.beginPath();
  for (const p of sigil.pts) {
    if (p.start) ctx.moveTo(p.x * dpr, p.y * dpr); else ctx.lineTo(p.x * dpr, p.y * dpr);
  }
  ctx.stroke();
}

function bindSigil() {
  const c = $('sigil');
  const add = (e, start) => {
    const r = c.getBoundingClientRect();
    const co = e.getCoalescedEvents?.();
    for (const ev of (co && co.length ? co : [e])) { // empty on pointerdown and for synthetic events
      sigil.pts.push({ x: ev.clientX - r.left, y: ev.clientY - r.top, t: ev.timeStamp, p: ev.pressure, start });
      start = false;
    }
    redrawSigil();
  };
  c.addEventListener('pointerdown', (e) => {
    try { c.setPointerCapture(e.pointerId); } catch {}
    sigil.drawing = true; add(e, true);
    if (!sigil.t0) { sigil.t0 = performance.now(); sigilTimer(); }
  });
  c.addEventListener('pointermove', (e) => { if (sigil.drawing) add(e, false); });
  const up = () => { sigil.drawing = false; };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  $('sigilClear').addEventListener('click', clearSigil);
}

// Stretch a seed into n bits with SHA-256 in counter mode.
async function expandBits(seed, n) {
  const bits = [];
  for (let ctr = 0; bits.length < n; ctr++) {
    const block = new Uint8Array(seed.length + 4);
    block.set(seed); new DataView(block.buffer).setUint32(seed.length, ctr);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', block));
    for (let i = 0; i < 256 && bits.length < n; i++) bits.push((h[i >> 3] >> (i & 7)) & 1);
  }
  return bits;
}

async function collapse() {
  const plan = digPlan();
  if (!plan) { $('quantum').close(); return; }
  els.qGo.hidden = true;
  cancelAnimationFrame(sigil.raf);
  // Every stroke sample (x, y, time, pressure), condensed into a seed.
  const raw = new Float64Array(sigil.pts.length * 4);
  sigil.pts.forEach((p, i) => raw.set([p.x, p.y, p.t, p.p], i * 4));
  const bits = await expandBits(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), Q_BITS);
  const points = bitsToPoints(bits, Q_POINTS, plan.dur);
  const { ranges } = anomalyRanges({ points, dur: plan.dur, n: plan.want, len: plan.L, taken: plan.taken, onsets: plan.onsets });
  $('quantum').close();
  placeDig(plan, ranges);
  toast(t('qDone', { n: ranges.length }), 3000, undoAction());
}

// ---------- export ----------
async function exportZip() {
  const list = sorted();
  if (!list.length) return;
  els.exportBtn.disabled = true;
  try {
    const names = uniqueNames(list.map((r) => r.name));
    const files = [];
    for (let i = 0; i < list.length; i++) {
      toast(t('processing', { i: i + 1, n: list.length }));
      const b = await renderedBuffer(list[i]);
      const chans = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
      files.push({ name: `${packSlug()}/${names[i]}.wav`, data: encodeWav(chans) }); // one folder, named after the pack
    }
    const blob = new Blob([makeZip(files)], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${packSlug()}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    const nb = Math.ceil(files.length / state.bankSize);
    toast(t('zipReady', { n: files.length, b: nb, banks: t('bank', { n: nb }) }), 2500);
  } catch (e) {
    console.error(e);
    toast(t('zipFail'), 3500);
  } finally {
    els.exportBtn.disabled = false;
  }
}

// ---------- recording ----------
// Captures raw PCM through an AudioWorklet (no lossy re-encode) with Chrome's
// voice processing turned off, then trims leading/trailing silence.
const REC_MAX_S = 300;
const REC_SILENCE = 0.001; // ≈ -60 dBFS
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
// Mic input gain (dB), adjustable while recording: raw phone mics are quiet without the
// browser's auto gain, and more gain brings up the room/ambience.
const MIC_GAIN_KEY = 'chochop.micgain';
let micGainDb = 12;
try { const g = localStorage.getItem(MIC_GAIN_KEY); if (g !== null && +g >= 0 && +g <= 36) micGainDb = +g; } catch {}
let rec = null;
let recWorklet = null;

async function startRec(kind) {
  els.recmenu.open = false;
  if (rec) return;
  stop();
  let stream;
  try {
    stream = kind === 'mic'
      ? await navigator.mediaDevices.getUserMedia({ audio: { ...RAW, channelCount: { ideal: 2 } } })
      : await navigator.mediaDevices.getDisplayMedia({
        // Video is mandatory for display capture but unused, so keep it tiny.
        video: { displaySurface: kind === 'system' ? 'monitor' : 'browser', frameRate: { max: 5 }, width: { max: 640 } },
        audio: { ...RAW, suppressLocalAudioPlayback: false },
        systemAudio: 'include', monitorTypeSurfaces: 'include',
        selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
      });
  } catch (e) {
    if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') {
      console.error(e);
      toast(t('recFail'), 3500);
    }
    return;
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    toast(t(kind === 'system' ? 'noSysAudio' : 'noAudioTrack'), 7000);
    return;
  }
  const ctx = audio();
  await ctx.resume();
  recWorklet ||= ctx.audioWorklet.addModule('rec-worklet.js');
  await recWorklet;
  const ch = kind === 'mic' ? Math.min(2, track.getSettings().channelCount || 1) : 2;
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'rec', { channelCount: ch, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  const pre = ctx.createGain(); // input gain (mic only; unity for tab/system)
  pre.gain.value = kind === 'mic' ? 10 ** (micGainDb / 20) : 1;
  const mute = ctx.createGain();
  mute.gain.value = 0; // keep the node pulled by the graph without monitoring the input
  src.connect(pre).connect(node).connect(mute).connect(ctx.destination);

  const r = { kind, stream, src, pre, node, mute, ch, sr: ctx.sampleRate, chunks: [], frames: 0, peak: 0, heard: false };
  rec = r;
  node.port.onmessage = (e) => {
    if (e.data === 'done') { r.onDone?.(); return; }
    r.chunks.push(e.data);
    r.frames += e.data[0].length;
    let p = 0;
    for (const c of e.data) for (let i = 0; i < c.length; i += 4) { const a = Math.abs(c[i]); if (a > p) p = a; }
    r.peak = Math.max(p, r.peak * 0.8);
    if (p > REC_SILENCE) r.heard = true;
    if (r.frames / r.sr >= REC_MAX_S) stopRec(true);
  };
  stream.getTracks().forEach((t) => t.addEventListener('ended', () => stopRec(true)));

  r.hint = { tab: 'recTabHint', system: 'recSysHint' }[kind] || '';
  $('recGainWrap').hidden = kind !== 'mic';
  showMicGain();
  renderRecLabels();
  els.recbar.hidden = false;
  r.timer = setInterval(() => {
    els.recTime.textContent = fmtClock(r.frames / r.sr) + ` / ${REC_MAX_S / 60}:00`;
    els.recLevel.style.width = Math.min(100, Math.sqrt(r.peak) * 100) + '%';
    els.recLevel.classList.toggle('hot', r.peak > 0.98);
    const noSound = kind === 'system' ? 'recNoSoundSys' : 'recNoSound';
    if (kind !== 'mic' && !r.heard && r.frames / r.sr > 6) {
      if (r.hint !== noSound) { r.hint = noSound; renderRecLabels(); }
    } else if (r.heard && kind !== 'mic' && r.hint !== 'recHeard') {
      r.hint = 'recHeard'; renderRecLabels();
    }
  }, 100);
}

async function stopRec(keep) {
  const r = rec;
  if (!r || r.stopping) return;
  r.stopping = true;
  clearInterval(r.timer);
  await new Promise((res) => { r.onDone = res; r.node.port.postMessage('flush'); setTimeout(res, 600); });
  r.stream.getTracks().forEach((t) => t.stop());
  r.src.disconnect(); r.pre.disconnect(); r.node.disconnect(); r.mute.disconnect();
  rec = null;
  els.recbar.hidden = true;
  els.recTime.textContent = '0:00';
  els.recLevel.style.width = '0';
  if (!keep) return;

  const total = r.chunks.reduce((n, k) => n + k[0].length, 0);
  const chans = Array.from({ length: r.ch }, (_, c) => {
    const out = new Float32Array(total);
    let o = 0;
    for (const k of r.chunks) { out.set(k[c] || k[0], o); o += k[0].length; }
    return out;
  });
  const loud = (i) => { for (const d of chans) if (Math.abs(d[i]) > REC_SILENCE) return true; return false; };
  let first = -1, last = -1;
  for (let i = 0; i < total; i++) if (loud(i)) { first = i; break; }
  for (let i = total - 1; i > first; i--) if (loud(i)) { last = i; break; }
  if (first < 0) {
    toast(t('recSilent'), 5000);
    return;
  }
  const pad = Math.round(0.01 * r.sr);
  const a = Math.max(0, first - pad), b = Math.min(total, Math.max(last, first) + pad + 1);
  const buf = audio().createBuffer(r.ch, b - a, r.sr);
  chans.forEach((d, c) => buf.copyToChannel(d.subarray(a, b), c));
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  setBuffer(buf, `${{ tab: 'tab', system: 'pc', mic: 'mic' }[r.kind]}-${hhmm}.wav`);
  toast(t('recDone', { d: fmtT(buf.duration) }), 3000, state.buffer && undoSnap ? undoAction() : null);
}

function showMicGain() {
  $('recGain').value = micGainDb;
  $('recGainVal').textContent = `+${micGainDb} dB`;
}

function renderRecLabels() {
  if (!rec) return;
  els.recLabel.textContent = t({ tab: 'recTab', system: 'recSys', mic: 'recMic' }[rec.kind]);
  els.recHint.textContent = rec.hint ? t(rec.hint) : '';
}

// The pixel font isn't monospaced, so each character sits in a fixed-width cell
// (otherwise the clock changes width as digits change and shoves the buttons).
function setClock(str) {
  const c = els.clock;
  if (c.childElementCount !== str.length) {
    c.replaceChildren(...[...str].map(() => document.createElement('span')));
  }
  [...str].forEach((ch, i) => {
    const span = c.children[i];
    if (span.textContent !== ch) { span.textContent = ch; span.className = /\d/.test(ch) ? '' : 'sep'; }
  });
}

function fmtClockFine(s) {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

function fmtClock(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function bindRec() {
  const md = navigator.mediaDevices;
  const canTab = !!md?.getDisplayMedia && !/Mobi|Android/i.test(navigator.userAgent);
  const canMic = !!md?.getUserMedia;
  $('recTab').hidden = !canTab;
  $('recSys').hidden = !canTab;
  $('recMic').hidden = !canMic;
  els.recmenu.hidden = !canTab && !canMic;
  $('recTab').addEventListener('click', () => startRec('tab'));
  $('recSys').addEventListener('click', () => startRec('system'));
  $('recMic').addEventListener('click', () => startRec('mic'));
  $('recStop').addEventListener('click', () => stopRec(true));
  $('recCancel').addEventListener('click', () => stopRec(false));
  $('recGain').addEventListener('input', (e) => {
    micGainDb = +e.target.value;
    showMicGain();
    if (rec?.pre) rec.pre.gain.setTargetAtTime(10 ** (micGainDb / 20), rec.pre.context.currentTime, 0.02);
    try { localStorage.setItem(MIC_GAIN_KEY, String(micGainDb)); } catch {}
  });
  document.addEventListener('click', (e) => { if (!els.recmenu.contains(e.target)) els.recmenu.open = false; });
}

// ---------- misc ----------
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
let toastTimer = null;
function toast(msg, ms, action) {
  els.toast.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toastbtn'; b.textContent = action.label;
    b.addEventListener('click', () => { hideToast(); action.run(); });
    els.toast.append(b);
  }
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { els.toast.hidden = true; }

function bindGlobal() {
  $('openBtn').addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', () => { const f = els.file.files[0]; if (f) loadFile(f); els.file.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); els.wavewrap.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); els.wavewrap.classList.remove('over'); }));
  document.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f); });

  $('zoomall').addEventListener('click', () => setView(0, state.buffer.duration));
  $('playall').addEventListener('click', playOriginal);
  $('stop').addEventListener('click', () => { stop(); draw(); });
  $('dig').addEventListener('click', dig);
  els.qGo.addEventListener('click', collapse);
  $('qCancel').addEventListener('click', () => $('quantum').close());
  $('quantum').addEventListener('close', () => cancelAnimationFrame(sigil.raf));
  $('quantum').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  bindSigil();
  $('clear').addEventListener('click', () => {
    if (!state.regions.length) return;
    snapshot();
    state.regions = []; state.sel = null; refresh();
    toast(t('cleared'), 3000, undoAction());
  });
  els.digLen.addEventListener('input', applyDigLen);
  document.querySelectorAll('input[name=bank]').forEach((el) => el.addEventListener('change', () => setBankSize(+el.value)));
  // Touch presses only count as a user gesture on release, so resume audio there too.
  const unlock = () => { if (actx && actx.state === 'suspended') actx.resume(); };
  document.addEventListener('pointerup', unlock);
  document.addEventListener('touchend', unlock);
  els.exportBtn.addEventListener('click', exportZip);

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ' && !e.shiftKey && !typing && undoSnap) {
      e.preventDefault(); undo(); return;
    }
    if (e.key === 'Escape' && els.recmenu.open) { els.recmenu.open = false; return; }
    if (!state.buffer || rec || e.metaKey || e.ctrlKey || e.altKey) return;
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
    } else if (e.code === 'KeyD' && e.shiftKey) {
      dig();
    } else if (PAD_CODES.indexOf(e.code) >= 0 && PAD_CODES.indexOf(e.code) < state.bankSize && !e.shiftKey) {
      if (e.repeat) return;
      const r = sorted()[activeBank() * state.bankSize + PAD_CODES.indexOf(e.code)];
      if (r) { e.preventDefault(); hit(r); }
    } else if (e.key === 'k' || e.key === 'K') {
      const r = getSel(); if (r) toggleKeep(r);
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
}

function bindLang() {
  document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  onLangChange(() => { renderMeta(); renderRecLabels(); refresh(); });
  applyI18n();
}

// "How it works" dialog: shown on arrival unless dismissed for good.
const HOWTO_KEY = 'chochop.howto';
function bindHowto() {
  const d = $('howto'), noShow = $('howNoShow');
  const hidden = () => { try { return localStorage.getItem(HOWTO_KEY) === 'hide'; } catch { return false; } };
  const open = () => { noShow.checked = hidden(); if (!d.open) d.showModal(); };
  d.addEventListener('close', () => {
    try { noShow.checked ? localStorage.setItem(HOWTO_KEY, 'hide') : localStorage.removeItem(HOWTO_KEY); } catch {}
  });
  $('howClose').addEventListener('click', () => d.close());
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // backdrop
  $('howBtn').addEventListener('click', open);
  if (!hidden()) open();

  const priv = $('privacy');
  $('privBtn').addEventListener('click', () => priv.showModal());
  $('privClose').addEventListener('click', () => priv.close());
  priv.addEventListener('click', (e) => { if (e.target === priv) priv.close(); });
}

function bindPack() {
  els.pack.addEventListener('input', () => {
    setPack(els.pack.value);
    renumber();
    refresh();
  });
}

setClock('00:00.00');
bindLang();
try { const n = +localStorage.getItem(BANK_KEY); if ([8, 12, 16].includes(n)) state.bankSize = n; } catch {}
document.querySelector(`input[name=bank][value="${state.bankSize}"]`).checked = true;
els.digN.value = state.bankSize;
setReady(false);
refresh();
bindHowto();
bindPack();
bindGlobal();
bindRec();
bindWave();
bindInspector();
