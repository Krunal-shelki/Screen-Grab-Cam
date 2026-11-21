import { loadOpenCV, Detector, Warper, pointInQuad } from './vision.js';
import { createDemoFeed } from './demo.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const DETECT_INTERVAL = 90;
const WARP_INTERVAL = 1000 / 30;
const LOST_TIMEOUT = 1600;
const DEBUG_FLAGS = new URLSearchParams(location.search);
const SKIP = {
  detect: DEBUG_FLAGS.has('nodetect'),
  warp: DEBUG_FLAGS.has('nowarp'),
  overlay: DEBUG_FLAGS.has('nooverlay'),
  cv: DEBUG_FLAGS.has('nocv'),
  wake: DEBUG_FLAGS.has('nowake'),
  devices: DEBUG_FLAGS.has('nodevices'),
};
const DEFAULT_CORNERS = [
  { x: 0.12, y: 0.16 },
  { x: 0.88, y: 0.16 },
  { x: 0.88, y: 0.84 },
  { x: 0.12, y: 0.84 },
];

const els = {
  app: $('app'),
  stage: $('stage'),
  video: $('video'),
  overlay: $('overlay'),
  hud: $('hud'),
  resBadge: $('resBadge'),
  toast: $('toast'),
  recBadge: $('recBadge'),
  recTime: $('recTime'),
  pip: $('pip'),
  pipTag: $('pipTag'),
  outputCanvas: $('outputCanvas'),
  expandBtn: $('expandBtn'),
  stageEmpty: $('stageEmpty'),
  sheet: $('sheet'),
  cameraSelect: $('cameraSelect'),
  flipBtn: $('flipBtn'),
  torchBtn: $('torchBtn'),
  aspectSelect: $('aspectSelect'),
  lockBtn: $('lockBtn'),
  editBtn: $('editBtn'),
  recordBtn: $('recordBtn'),
  snapBtn: $('snapBtn'),
  outputBtn: $('outputBtn'),
  outputView: $('outputView'),
  outputSlot: $('outputSlot'),
  closeOutputBtn: $('closeOutputBtn'),
  ovSnapBtn: $('ovSnapBtn'),
  ovRecordBtn: $('ovRecordBtn'),
  ovSize: $('ovSize'),
  gate: $('gate'),
  gateStatus: $('gateStatus'),
  startBtn: $('startBtn'),
  demoBtn: $('demoBtn'),
  status: $('status'),
  statusText: $('statusText'),
  installBtn: $('installBtn'),
  banner: $('banner'),
  bannerText: $('bannerText'),
  bannerAction: $('bannerAction'),
  bannerClose: $('bannerClose'),
};

function dbg(msg) {
  if (!DEBUG_FLAGS.has('debug')) return;
  try { fetch('/__log?msg=' + encodeURIComponent('app: ' + msg)); } catch {}
}

const state = {
  running: false,
  starting: false,
  kind: null,
  stream: null,
  track: null,
  deviceId: null,
  devices: [],
  cvReady: false,
  cvLoading: false,
  corners: null,
  candidates: [],
  mode: 'auto',
  aspect: 'auto',
  misses: 0,
  lastSeen: 0,
  confidence: 0,
  lastDetect: 0,
  lastWarp: 0,
  drag: null,
  tap: null,
  raf: 0,
  rec: null,
  recording: false,
  chunks: [],
  recStart: 0,
  recTimer: 0,
  capture: null,
  torch: false,
  torchSupported: false,
  wakeLock: null,
  demo: null,
  installPrompt: null,
  outW: 0,
  outH: 0,
  outputOpen: false,
  toastTimer: 0,
  lastStatus: '',
  lastRes: '',
};

const detector = new Detector();
const warper = new Warper(els.outputCanvas);

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */

function setStatus(text, tone = 'idle') {
  if (state.lastStatus === text && els.status.dataset.tone === tone) return;
  state.lastStatus = text;
  els.statusText.textContent = text;
  els.status.dataset.tone = tone;
}

function toast(message, ms = 2200) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function showBanner(message, actionLabel, action) {
  els.bannerText.textContent = message;
  if (actionLabel && action) {
    els.bannerAction.hidden = false;
    els.bannerAction.textContent = actionLabel;
    els.bannerAction.onclick = action;
  } else {
    els.bannerAction.hidden = true;
    els.bannerAction.onclick = null;
  }
  els.banner.hidden = false;
}

function hideBanner() {
  els.banner.hidden = true;
}

function cameraErrorMessage(err) {
  if (!window.isSecureContext) {
    return 'Camera access needs a secure connection. Open this page over HTTPS or on localhost.';
  }
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was blocked. Allow camera access for this site in your browser settings, then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is busy in another app. Close other camera apps and try again.';
    case 'OverconstrainedError':
      return 'This camera could not provide a usable video mode. Try again.';
    default:
      return 'Could not start the camera: ' + ((err && err.message) || 'unknown error');
  }
}

function updateControls() {
  const ready = state.cvReady;
  const hasCorners = !!state.corners;
  const editing = state.mode === 'edit';
  const locked = state.mode === 'locked';

  els.lockBtn.disabled = !hasCorners || editing;
  els.editBtn.disabled = !ready;
  els.recordBtn.disabled = !hasCorners || !ready;
  els.snapBtn.disabled = !hasCorners || !ready;
  els.outputBtn.disabled = !hasCorners || !ready;
  els.ovSnapBtn.disabled = !hasCorners || !ready;
  els.ovRecordBtn.disabled = !hasCorners || !ready;

  els.lockBtn.innerHTML = `<svg class="icon"><use href="#i-${locked ? 'unlock' : 'lock'}"/></svg><span>${locked ? 'Unlock' : 'Lock'}</span>`;
  els.lockBtn.dataset.active = locked ? 'true' : 'false';
  els.editBtn.innerHTML = editing
    ? '<svg class="icon"><use href="#i-check"/></svg><span>Done</span>'
    : '<svg class="icon"><use href="#i-corners"/></svg><span>Corners</span>';
  els.editBtn.dataset.active = editing ? 'true' : 'false';
}

function updateHud(force) {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const text = vw && vh ? `${vw}×${vh}` : '—';
  if (force || text !== state.lastRes) {
    state.lastRes = text;
    els.resBadge.textContent = text;
  }
}

function updateTorchUI() {
  els.torchBtn.dataset.active = state.torch ? 'true' : 'false';
  els.torchBtn.title = state.torch ? 'Turn torch off' : 'Turn torch on';
}

/* ------------------------------------------------------------------ */
/* camera                                                              */
/* ------------------------------------------------------------------ */

async function startCamera(deviceId) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera API unavailable');
  }
  stopCamera();
  const video = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: 'environment' };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  } catch (err) {
    if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    } else {
      throw err;
    }
  }
  applyStream(stream, 'camera');
}

function applyStream(stream, kind) {
  dbg('applyStream ' + kind);
  state.stream = stream;
  state.kind = kind;
  state.track = stream.getVideoTracks()[0] || null;
  state.deviceId = state.track && state.track.getSettings ? state.track.getSettings().deviceId || null : null;
  els.video.srcObject = stream;
  const play = els.video.play();
  if (play && play.catch) play.catch(() => {});
  dbg('applyStream: playing');

  resetTracking();
  dbg('applyStream: reset');
  state.running = true;
  startLoop();
  dbg('applyStream: loop');
  updateTorchCapabilities();
  if (!SKIP.devices) refreshDevices();
  if (!SKIP.wake) requestWakeLock();
  updateHud(true);
  updateControls();
  dbg('applyStream: done');
  if (kind === 'demo') setStatus('Demo feed', 'live');
  else setStatus(state.cvReady ? 'Searching…' : 'Starting…', state.cvReady ? 'live' : 'warn');
}

function stopCamera() {
  if (state.recording) stopRecording();
  if (state.demo) {
    try { state.demo.stop(); } catch {}
    state.demo = null;
  }
  if (state.stream) {
    for (const track of state.stream.getTracks()) {
      try { track.stop(); } catch {}
    }
  }
  state.stream = null;
  state.track = null;
  state.kind = null;
  els.video.srcObject = null;
  state.running = false;
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = 0;
  if (state.wakeLock) {
    try { state.wakeLock.release(); } catch {}
    state.wakeLock = null;
  }
  resetTracking();
}

function resetTracking() {
  state.corners = null;
  state.candidates = [];
  state.mode = 'auto';
  state.misses = 0;
  state.confidence = 0;
  state.outW = 0;
  state.outH = 0;
  warper.reset();
  els.pip.hidden = true;
  closeOutputView();
  els.stage.classList.remove('edit');
  els.stageEmpty.hidden = !!state.stream;
  updateControls();
  drawOverlay();
}

function updateTorchCapabilities() {
  const caps = (state.track && state.track.getCapabilities && state.track.getCapabilities()) || {};
  state.torchSupported = !!caps.torch;
  els.torchBtn.hidden = !state.torchSupported;
  if (!state.torchSupported) state.torch = false;
  updateTorchUI();
}

async function toggleTorch() {
  if (!state.track || !state.torchSupported) return;
  const next = !state.torch;
  try {
    await state.track.applyConstraints({ advanced: [{ torch: next }] });
    state.torch = next;
    updateTorchUI();
  } catch {
    toast('Torch is not available on this camera');
  }
}

async function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let all = [];
  try {
    all = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const cams = all.filter((d) => d.kind === 'videoinput');
  state.devices = cams;

  const select = els.cameraSelect;
  const previous = state.kind === 'demo' ? 'demo' : state.deviceId || select.value;
  select.innerHTML = '';
  cams.forEach((d, i) => {
    const option = document.createElement('option');
    option.value = d.deviceId;
    option.textContent = d.label || `Camera ${i + 1}`;
    select.append(option);
  });
  if (!cams.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No camera found';
    select.append(option);
  }
  if (state.kind === 'demo') {
    const option = document.createElement('option');
    option.value = 'demo';
    option.textContent = 'Demo feed';
    select.append(option);
  }
  if (previous === 'demo' && state.kind === 'demo') {
    select.value = 'demo';
  } else if (previous && cams.some((d) => d.deviceId === previous)) {
    select.value = previous;
  }
  els.flipBtn.disabled = cams.length < 2;
}

async function cycleCamera() {
  if (state.devices.length < 2) {
    toast('Only one camera is available');
    return;
  }
  const index = state.devices.findIndex((d) => d.deviceId === state.deviceId);
  const next = state.devices[(index + 1 + state.devices.length) % state.devices.length];
  try {
    await startCamera(next.deviceId);
    els.cameraSelect.value = next.deviceId;
  } catch (err) {
    toast(cameraErrorMessage(err), 3200);
  }
}

function requestWakeLock() {
  if (SKIP.wake || !('wakeLock' in navigator) || !state.running) return;
  try {
    navigator.wakeLock.request('screen').then((lock) => {
      state.wakeLock = lock;
    }).catch(() => {});
  } catch {}
}

/* ------------------------------------------------------------------ */
/* vision engine                                                       */
/* ------------------------------------------------------------------ */

async function ensureOpenCV() {
  if (state.cvReady) return true;
  if (state.cvLoading) return false;
  state.cvLoading = true;
  setStatus('Loading vision…', 'warn');
  dbg('ensure start');
  try {
    await loadOpenCV();
    const cv = window.cv;
    if (!cv || !cv.Mat) throw new Error('Vision engine did not initialise');
    dbg('ensure loaded');
    detector.init(cv);
    dbg('detector init');
    state.cvReady = true;
    state.cvLoading = false;
    hideBanner();
    setStatus(state.kind === 'demo' ? 'Demo feed' : 'Searching…', 'live');
    updateControls();
    return true;
  } catch (err) {
    console.error('[ScreenGrab] vision engine:', err);
    state.cvLoading = false;
    setStatus('Vision offline', 'error');
    showBanner(
      'The screen-detection engine could not load. Check your connection, then retry.',
      'Retry',
      () => { ensureOpenCV().catch(() => {}); }
    );
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* boot / gate                                                         */
/* ------------------------------------------------------------------ */

async function boot() {
  if (state.starting) return;
  if (!window.isSecureContext) {
    els.gateStatus.textContent = 'Camera access needs a secure connection. Open this page over HTTPS or on localhost.';
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    els.gateStatus.textContent = 'This browser does not support camera access. Try Chrome, Safari or Firefox over HTTPS.';
    return;
  }
  state.starting = true;
  els.startBtn.disabled = true;
  els.gateStatus.textContent = 'Requesting camera…';
  try {
    await startCamera(null);
  } catch (err) {
    console.error('[ScreenGrab] camera:', err);
    state.starting = false;
    els.startBtn.disabled = false;
    els.gateStatus.textContent = cameraErrorMessage(err);
    return;
  }
  state.starting = false;
  els.gateStatus.textContent = '';
  els.gate.hidden = true;
  els.stageEmpty.hidden = true;
  toast('Point the camera at a screen', 3000);
  if (!SKIP.cv) ensureOpenCV().catch(() => {});
}

async function startDemo() {
  dbg('startDemo');
  stopCamera();
  state.demo = createDemoFeed();
  dbg('startDemo: feed');
  applyStream(state.demo.stream, 'demo');
  dbg('startDemo: applied');
  els.gate.hidden = true;
  els.stageEmpty.hidden = true;
  if (!SKIP.cv) ensureOpenCV().catch(() => {});
  dbg('startDemo: end');
}

function hideGate() {
  els.gate.hidden = true;
}

/* ------------------------------------------------------------------ */
/* service worker + install                                            */
/* ------------------------------------------------------------------ */

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((err) => {
    console.warn('[ScreenGrab] service worker:', err);
  });
}

function setupInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    els.installBtn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    els.installBtn.hidden = true;
    toast('ScreenGrab installed');
  });
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) els.installBtn.hidden = true;
}

/* ------------------------------------------------------------------ */
/* render loop + detection                                             */
/* ------------------------------------------------------------------ */

function startLoop() {
  if (state.raf) return;
  state.lastDetect = 0;
  state.lastWarp = 0;
  state.raf = requestAnimationFrame(loop);
}

function loop(ts) {
  if (!state.running) {
    state.raf = 0;
    return;
  }
  state.raf = requestAnimationFrame(loop);
  if (els.video.readyState < 2) return;

  if (!SKIP.detect && state.cvReady && state.mode === 'auto' && ts - state.lastDetect >= DETECT_INTERVAL) {
    state.lastDetect = ts;
    runDetection(ts);
  }
  if (!SKIP.warp && state.cvReady && state.corners && ts - state.lastWarp >= WARP_INTERVAL) {
    state.lastWarp = ts;
    renderWarp(false);
  }
  if (!SKIP.overlay) drawOverlay();
}

function runDetection(now) {
  let result;
  try {
    result = detector.detect(els.video, state.corners);
  } catch (err) {
    console.error('[ScreenGrab] detect:', err);
    return;
  }
  state.candidates = result.candidates || [];
  const best = result.best;

  if (best) {
    state.misses = 0;
    state.lastSeen = now;
    state.confidence = best.score;
    if (!state.corners) {
      state.corners = best.pts.map((p) => ({ x: p.x, y: p.y }));
      onCornersChanged(true);
      renderWarp(true);
    } else {
      smoothTo(best.pts);
    }
    setStatus(state.kind === 'demo' ? 'Demo · tracking' : 'Tracking', 'live');
  } else {
    state.misses += 1;
    if (state.corners && now - state.lastSeen > LOST_TIMEOUT) {
      state.corners = null;
      state.candidates = [];
      state.confidence = 0;
      onCornersChanged(true);
      setStatus('Searching…', 'warn');
    }
  }
}

function smoothTo(target) {
  const prev = state.corners;
  if (!prev) {
    state.corners = target.map((p) => ({ x: p.x, y: p.y }));
    return;
  }
  let move = 0;
  for (let i = 0; i < 4; i++) {
    move += Math.hypot(prev[i].x - target[i].x, prev[i].y - target[i].y);
  }
  move /= 4;
  const alpha = move > 0.05 ? 0.9 : 0.45;
  state.corners = target.map((p, i) => ({
    x: prev[i].x + (p.x - prev[i].x) * alpha,
    y: prev[i].y + (p.y - prev[i].y) * alpha,
  }));
}

function onCornersChanged(force) {
  if (force) {
    state.outW = 0;
    state.outH = 0;
    warper.reset();
  }
  els.pip.hidden = !state.corners;
  els.stageEmpty.hidden = true;
  updateControls();
  drawOverlay();
}

/* ------------------------------------------------------------------ */
/* rectified output                                                    */
/* ------------------------------------------------------------------ */

function renderWarp(force) {
  if (SKIP.warp || !state.cvReady || !state.corners) return;
  let result;
  try {
    result = warper.render(els.video, state.corners, force);
  } catch (err) {
    console.error('[ScreenGrab] warp:', err);
    return;
  }
  if (!result) return;

  const changed = result.w !== state.outW || result.h !== state.outH;
  state.outW = result.w;
  state.outH = result.h;
  els.pip.hidden = false;
  els.stageEmpty.hidden = true;
  if (changed) {
    els.pipTag.textContent = `OUTPUT ${result.w}×${result.h}`;
    els.ovSize.textContent = `${result.w}×${result.h}`;
    updateControls();
  }
}

function videoRect(width, height) {
  const vw = els.video.videoWidth || 16;
  const vh = els.video.videoHeight || 9;
  const scale = Math.min(width / vw, height / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

/* ------------------------------------------------------------------ */
/* overlay drawing                                                     */
/* ------------------------------------------------------------------ */

function drawOverlay() {
  const rect = els.stage.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(rect.width * dpr);
  const ch = Math.round(rect.height * dpr);
  if (els.overlay.width !== cw || els.overlay.height !== ch) {
    els.overlay.width = cw;
    els.overlay.height = ch;
  }
  const ctx = els.overlay.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!state.corners) return;

  const vr = videoRect(rect.width, rect.height);
  const pts = state.corners.map((p) => ({
    x: vr.x + p.x * vr.w,
    y: vr.y + p.y * vr.h,
  }));
  const editing = state.mode === 'edit';
  const locked = state.mode === 'locked';

  ctx.beginPath();
  ctx.rect(0, 0, rect.width, rect.height);
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(3, 7, 11, 0.55)';
  ctx.fill('evenodd');

  ctx.save();
  ctx.strokeStyle = locked ? '#fbbf24' : '#2dd4bf';
  ctx.lineWidth = editing ? 2.5 : 2;
  ctx.shadowColor = locked ? 'rgba(251, 191, 36, 0.55)' : 'rgba(45, 212, 191, 0.6)';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  const radius = editing ? 9 : 3.2;
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = editing ? '#ffffff' : locked ? '#fbbf24' : '#2dd4bf';
    ctx.fill();
    if (editing) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0b1220';
      ctx.stroke();
    }
  }

  if (editing) {
    const top = Math.min(...pts.map((p) => p.y));
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.font = '600 10px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Drag a corner', (pts[0].x + pts[1].x) / 2, Math.max(14, top - 12));
  }
}

/* ------------------------------------------------------------------ */
/* pointer: tap to pick, drag corners in edit mode                     */
/* ------------------------------------------------------------------ */

function stagePoint(event) {
  const rect = els.stage.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    w: rect.width,
    h: rect.height,
  };
}

function videoPoint(point) {
  const vr = videoRect(point.w, point.h);
  return {
    x: clamp((point.x - vr.x) / vr.w, 0, 1),
    y: clamp((point.y - vr.y) / vr.h, 0, 1),
  };
}

function onPointerDown(event) {
  if (!state.running) return;
  const point = stagePoint(event);

  if (state.mode === 'edit' && state.corners) {
    const vr = videoRect(point.w, point.h);
    const pts = state.corners.map((p) => ({
      x: vr.x + p.x * vr.w,
      y: vr.y + p.y * vr.h,
    }));
    let hit = -1;
    let best = 38;
    pts.forEach((p, i) => {
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d < best) { best = d; hit = i; }
    });
    if (hit >= 0) {
      state.drag = hit;
      try { els.overlay.setPointerCapture(event.pointerId); } catch {}
      event.preventDefault();
    }
    return;
  }

  state.tap = { x: event.clientX, y: event.clientY, at: performance.now() };
}

function onPointerMove(event) {
  if (state.drag === null) return;
  const point = stagePoint(event);
  state.corners[state.drag] = videoPoint(point);
  state.misses = 0;
  state.lastSeen = performance.now();
  renderWarp(false);
  drawOverlay();
  event.preventDefault();
}

function onPointerUp(event) {
  if (state.drag !== null) {
    state.drag = null;
    try { els.overlay.releasePointerCapture(event.pointerId); } catch {}
    return;
  }

  const tap = state.tap;
  state.tap = null;
  if (!tap || state.mode !== 'auto' || !state.candidates.length) return;
  if (performance.now() - tap.at > 600) return;
  if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 14) return;

  const n = videoPoint(stagePoint(event));
  const hit = state.candidates.find((c) => pointInQuad(n, c.pts));
  if (!hit) return;

  state.corners = hit.pts.map((p) => ({ x: p.x, y: p.y }));
  state.lastSeen = performance.now();
  state.misses = 0;
  onCornersChanged(true);
  setMode('locked');
  renderWarp(true);
  toast('Screen selected — tap Unlock to track again', 2800);
}

function onPointerCancel() {
  state.drag = null;
  state.tap = null;
}

/* ------------------------------------------------------------------ */
/* modes                                                               */
/* ------------------------------------------------------------------ */

function setMode(mode) {
  state.mode = mode;
  els.stage.classList.toggle('edit', mode === 'edit');
  if (mode === 'auto') {
    state.lastDetect = 0;
    state.lastSeen = performance.now();
    setStatus(state.kind === 'demo' ? 'Demo feed' : 'Searching…', 'live');
  } else if (mode === 'locked') {
    setStatus('Locked', 'warn');
  } else {
    setStatus('Adjust corners', 'warn');
  }
  updateControls();
  drawOverlay();
}

function toggleLock() {
  if (!state.corners || state.mode === 'edit') return;
  if (state.mode === 'locked') {
    setMode('auto');
    toast('Auto-tracking on');
  } else {
    setMode('locked');
    toast('Screen locked');
  }
}

function toggleEdit() {
  if (state.mode === 'edit') {
    setMode('locked');
    renderWarp(true);
    toast('Corners applied');
    return;
  }
  if (!state.cvReady) return;
  if (!state.corners) {
    state.corners = DEFAULT_CORNERS.map((p) => ({ x: p.x, y: p.y }));
    state.lastSeen = performance.now();
  }
  setMode('edit');
  onCornersChanged(true);
  renderWarp(true);
  toast('Drag the four corners to frame the screen', 3200);
}

function onAspectChange() {
  state.aspect = els.aspectSelect.value;
  warper.setAspect(state.aspect);
  state.outW = 0;
  state.outH = 0;
  try { localStorage.setItem('screengrab.aspect', state.aspect); } catch {}
  if (state.corners) renderWarp(true);
}

/* ------------------------------------------------------------------ */
/* output view                                                         */
/* ------------------------------------------------------------------ */

function openOutputView() {
  if (!state.outW) return;
  state.outputOpen = true;
  els.outputView.hidden = false;
  els.outputSlot.appendChild(els.outputCanvas);
  updateControls();
}

function closeOutputView() {
  if (!state.outputOpen) return;
  state.outputOpen = false;
  els.outputView.hidden = true;
  els.pip.insertBefore(els.outputCanvas, els.pip.firstChild);
}

/* ------------------------------------------------------------------ */
/* recording + snapshots                                               */
/* ------------------------------------------------------------------ */

function getOutputStream() {
  if (!state.capture) state.capture = els.outputCanvas.captureStream(30);
  return state.capture;
}

function toggleRecording() {
  if (state.recording) stopRecording();
  else startRecording();
}

function startRecording() {
  if (state.recording) return;
  if (!state.cvReady || !state.corners) {
    toast('Point at a screen first');
    return;
  }
  if (typeof MediaRecorder === 'undefined' || !els.outputCanvas.captureStream) {
    toast('Recording is not supported in this browser');
    return;
  }

  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  let mime = '';
  for (const type of types) {
    try {
      if (MediaRecorder.isTypeSupported(type)) { mime = type; break; }
    } catch {}
  }

  let stream;
  try {
    stream = getOutputStream();
  } catch {
    toast('Recording is not supported in this browser');
    return;
  }

  try {
    state.rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6000000 } : undefined);
  } catch (err) {
    console.error('[ScreenGrab] recorder:', err);
    toast('Could not start recording');
    return;
  }

  state.chunks = [];
  state.rec.ondataavailable = (event) => {
    if (event.data && event.data.size) state.chunks.push(event.data);
  };
  state.rec.onerror = (event) => {
    console.error('[ScreenGrab] recorder error:', event);
    toast('Recording stopped unexpectedly');
  };
  state.rec.onstop = () => {
    const blob = new Blob(state.chunks, { type: mime || 'video/webm' });
    state.chunks = [];
    state.recording = false;
    state.rec = null;
    clearInterval(state.recTimer);
    state.recTimer = 0;
    updateRecordUI();
    if (blob.size) {
      const ext = (mime || '').includes('mp4') ? 'mp4' : 'webm';
      downloadBlob(blob, `screengrab-${stamp()}.${ext}`);
    }
  };

  state.rec.start(1000);
  state.recording = true;
  state.recStart = performance.now();
  updateRecordUI();
  updateRecTime();
  state.recTimer = setInterval(updateRecTime, 500);
  toast('Recording the output feed', 1800);
}

function stopRecording() {
  if (!state.rec) {
    state.recording = false;
    updateRecordUI();
    return;
  }
  try {
    if (state.rec.state !== 'inactive') state.rec.stop();
  } catch {}
}

function updateRecordUI() {
  const rec = state.recording;
  const icon = rec ? 'stop' : 'record';
  const label = rec ? 'Stop' : 'Record';
  els.recordBtn.classList.toggle('recording', rec);
  els.recordBtn.innerHTML = `<svg class="icon"><use href="#i-${icon}"/></svg><span>${label}</span>`;
  els.ovRecordBtn.classList.toggle('recording', rec);
  els.ovRecordBtn.innerHTML = `<svg class="icon"><use href="#i-${icon}"/></svg><span>${label}</span>`;
  els.recBadge.hidden = !rec;
}

function updateRecTime() {
  const secs = Math.max(0, Math.floor((performance.now() - state.recStart) / 1000));
  els.recTime.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

function takeSnapshot() {
  if (!state.cvReady || !state.corners) return Promise.resolve(null);
  renderWarp(false);
  const canvas = els.outputCanvas;
  if (!canvas.width) return Promise.resolve(null);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `screengrab-${stamp()}.png`);
      resolve(blob);
    }, 'image/png');
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`Saved ${filename}`, 2600);
}

/* ------------------------------------------------------------------ */
/* wiring + init                                                       */
/* ------------------------------------------------------------------ */

function wireUI() {
  els.startBtn.addEventListener('click', boot);
  els.demoBtn.addEventListener('click', startDemo);

  els.cameraSelect.addEventListener('change', async () => {
    const value = els.cameraSelect.value;
    if (!value || value === 'demo') return;
    try {
      await startCamera(value);
    } catch (err) {
      toast(cameraErrorMessage(err), 3600);
      refreshDevices();
    }
  });

  els.flipBtn.addEventListener('click', cycleCamera);
  els.torchBtn.addEventListener('click', toggleTorch);
  els.aspectSelect.addEventListener('change', onAspectChange);
  els.lockBtn.addEventListener('click', toggleLock);
  els.editBtn.addEventListener('click', toggleEdit);

  els.recordBtn.addEventListener('click', toggleRecording);
  els.ovRecordBtn.addEventListener('click', toggleRecording);
  els.snapBtn.addEventListener('click', takeSnapshot);
  els.ovSnapBtn.addEventListener('click', takeSnapshot);

  els.expandBtn.addEventListener('click', openOutputView);
  els.outputBtn.addEventListener('click', openOutputView);
  els.closeOutputBtn.addEventListener('click', closeOutputView);

  els.bannerClose.addEventListener('click', hideBanner);
  els.installBtn.addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    try { await state.installPrompt.userChoice; } catch {}
    state.installPrompt = null;
    els.installBtn.hidden = true;
  });

  els.overlay.addEventListener('pointerdown', onPointerDown);
  els.overlay.addEventListener('pointermove', onPointerMove);
  els.overlay.addEventListener('pointerup', onPointerUp);
  els.overlay.addEventListener('pointercancel', onPointerCancel);

  els.video.addEventListener('loadedmetadata', () => {
    updateHud(true);
    onCornersChanged(true);
  });

  window.addEventListener('resize', drawOverlay);
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => drawOverlay()).observe(els.stage);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.running) requestWakeLock();
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  }

  try {
    const saved = localStorage.getItem('screengrab.aspect');
    if (saved && [...els.aspectSelect.options].some((o) => o.value === saved)) {
      els.aspectSelect.value = saved;
    }
  } catch {}
  state.aspect = els.aspectSelect.value;
  warper.setAspect(state.aspect);
}

function init() {
  wireUI();
  registerSW();
  setupInstall();
  refreshDevices();
  updateRecordUI();
  updateControls();
  updateHud(true);

  const params = new URLSearchParams(location.search);
  if (params.get('demo') === '1') startDemo();
  else if (params.get('autostart') === '1') boot();
}

window.screenGrab = {
  get canvas() { return els.outputCanvas; },
  getStream: getOutputStream,
  snapshot: takeSnapshot,
  get state() { return state; },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
