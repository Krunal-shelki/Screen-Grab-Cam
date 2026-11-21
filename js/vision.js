/* ScreenGrab — vision engine.
   OpenCV.js is used for screen detection (low-res, throttled) and for the
   perspective warp that produces the rectified output frame. */

const OPENCV_URL = 'https://docs.opencv.org/4.10.0/opencv.js';

const DETECT_WIDTH = 640;
const MAX_SRC = 1280;
const MAX_OUT = 1280;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

let cvPromise = null;

const DBG = new URLSearchParams(location.search).has('debug');
function dbg(msg) {
  if (!DBG) return;
  try { fetch('/__log?msg=' + encodeURIComponent('vision: ' + msg)); } catch {}
}

export function loadOpenCV() {
  dbg('load called, cv=' + !!(window.cv && window.cv.Mat));
  // Resolve with `true`, never with `cv` itself: the docs build is a thenable
  // Module, and resolving a promise with it deadlocks the runtime.
  if (window.cv && window.cv.Mat) return Promise.resolve(true);
  if (cvPromise) return cvPromise;

  cvPromise = new Promise((resolve, reject) => {
    let settled = false;
    let poll = 0;
    let timeout = 0;

    const done = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      dbg('resolved');
      resolve(true);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      dbg('rejected ' + (err && err.message));
      reject(err);
    };

    // Do not touch `cv.then` here: the docs build exposes a thenable Module,
    // and driving that promise can deadlock the runtime. Poll for `cv.Mat`
    // instead, which appears as soon as the wasm runtime is usable.
    const check = () => {
      const c = window.cv;
      if (c && c.Mat) done();
    };

    const script = document.createElement('script');
    script.src = OPENCV_URL;
    script.async = true;
    script.onload = () => {
      const c = window.cv;
      dbg('onload type=' + typeof c + ' then=' + !!(c && c.then) + ' mat=' + !!(c && c.Mat));
      check();
    };
    script.onerror = () => fail(new Error('Could not download the vision engine'));
    dbg('appending script');
    document.head.appendChild(script);

    poll = setInterval(check, 100);
    timeout = setTimeout(() => fail(new Error('Vision engine timed out')), 90000);
  });

  cvPromise.catch(() => { cvPromise = null; });
  return cvPromise;
}

/* ------------------------------------------------------------------ */
/* geometry helpers                                                    */
/* ------------------------------------------------------------------ */

function shoelace(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function orderQuad(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sorted = pts
    .map((p) => ({ x: p.x, y: p.y, a: Math.atan2(p.y - cy, p.x - cx) }))
    .sort((p, q) => p.a - q.a)
    .map(({ x, y }) => ({ x, y }));

  let start = 0;
  let best = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i].x + sorted[i].y;
    if (s < best) { best = s; start = i; }
  }
  const out = sorted.slice(start).concat(sorted.slice(0, start));

  const cross =
    (out[1].x - out[0].x) * (out[2].y - out[1].y) -
    (out[1].y - out[0].y) * (out[2].x - out[1].x);
  if (cross < 0) {
    const t = out[1];
    out[1] = out[3];
    out[3] = t;
  }
  return out;
}

function cornerCosines(q) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const prev = q[(i + 3) % 4];
    const cur = q[i];
    const next = q[(i + 1) % 4];
    const ax = prev.x - cur.x, ay = prev.y - cur.y;
    const bx = next.x - cur.x, by = next.y - cur.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) return [1, 1, 1, 1];
    out.push(Math.abs((ax * bx + ay * by) / (la * lb)));
  }
  return out;
}

function avgCornerDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += dist(a[i], b[i]);
  return sum / 4;
}

export function pointInQuad(p, q) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = q[i].x, yi = q[i].y;
    const xj = q[j].x, yj = q[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function rectToPoints(rect) {
  const rad = (rect.angle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const w = rect.size.width / 2, h = rect.size.height / 2;
  const pts = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => ({
    x: rect.center.x + x * cos - y * sin,
    y: rect.center.y + x * sin + y * cos,
  }));
  return orderQuad(pts);
}

function approxToPoints(mat) {
  const d = mat.data32S;
  return orderQuad([
    { x: d[0], y: d[1] },
    { x: d[2], y: d[3] },
    { x: d[4], y: d[5] },
    { x: d[6], y: d[7] },
  ]);
}

/* ------------------------------------------------------------------ */
/* detector                                                            */
/* ------------------------------------------------------------------ */

export class Detector {
  constructor() {
    this.cv = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.rgba = null;
    this.gray = null;
    this.blur = null;
    this.edges = null;
    this.kernel = null;
    this.w = 0;
    this.h = 0;
    this.lastMs = 0;
  }

  init(cv) {
    this.cv = cv;
    if (!this.kernel) {
      this.kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    }
  }

  _mats(w, h) {
    const cv = this.cv;
    if (this.w === w && this.h === h) return;
    for (const m of [this.rgba, this.gray, this.blur, this.edges]) m && m.delete();
    this.rgba = new cv.Mat(h, w, cv.CV_8UC4);
    this.gray = new cv.Mat(h, w, cv.CV_8UC1);
    this.blur = new cv.Mat(h, w, cv.CV_8UC1);
    this.edges = new cv.Mat(h, w, cv.CV_8UC1);
    this.w = w;
    this.h = h;
  }

  /* Returns { best, candidates, ms }. Quads are normalised 0..1. */
  detect(video, prevCorners) {
    const cv = this.cv;
    if (!cv) return { best: null, candidates: [], ms: 0 };
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return { best: null, candidates: [], ms: 0 };

    const scale = Math.min(1, DETECT_WIDTH / vw);
    const w = Math.max(80, Math.round(vw * scale));
    const h = Math.max(45, Math.round(vh * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(video, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    this._mats(w, h);
    this.rgba.data.set(img.data);

    const t0 = performance.now();
    cv.cvtColor(this.rgba, this.gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(this.gray, this.blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

    const raw = [];
    const mean = cv.mean(this.blur)[0];
    cv.Canny(
      this.blur,
      this.edges,
      Math.max(12, mean * 0.5),
      Math.min(255, Math.max(40, mean * 1.35)),
      3,
      false
    );
    cv.dilate(this.edges, this.edges, this.kernel, new cv.Point(-1, -1), 1);
    this._collect(this.edges, w, h, raw);

    let scored = this._score(raw, w, h, prevCorners);
    if (!scored.length || scored[0].score < 0.2) {
      cv.Canny(this.blur, this.edges, 30, 100, 3, false);
      cv.dilate(this.edges, this.edges, this.kernel, new cv.Point(-1, -1), 1);
      const raw2 = [];
      this._collect(this.edges, w, h, raw2);
      scored = this._merge(scored, this._score(raw2, w, h, prevCorners));
    }

    const best = scored[0] || null;
    this.lastMs = performance.now() - t0;
    return { best, candidates: scored, ms: this.lastMs };
  }

  _collect(edges, w, h, out) {
    const cv = this.cv;
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const minArea = w * h * 0.012;

    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      try {
        const area = cv.contourArea(c);
        if (area < minArea) continue;
        const peri = cv.arcLength(c, true);
        if (peri < 36) continue;

        let found = false;
        for (const eps of [0.02, 0.035, 0.055]) {
          const approx = new cv.Mat();
          cv.approxPolyDP(c, approx, eps * peri, true);
          const isQuad = approx.rows === 4 && cv.isContourConvex(approx);
          if (isQuad) {
            out.push(approxToPoints(approx));
            approx.delete();
            found = true;
            break;
          }
          approx.delete();
        }

        if (!found) {
          const hull = new cv.Mat();
          cv.convexHull(c, hull);
          const hullArea = cv.contourArea(hull);
          if (hullArea > w * h * 0.03) {
            const r = cv.minAreaRect(hull);
            const rw = r.size.width, rh = r.size.height;
            if (rw > 24 && rh > 24 && hullArea / (rw * rh) > 0.9) {
              out.push(rectToPoints(r));
            }
          }
          hull.delete();
        }
      } finally {
        c.delete();
      }
    }
    hierarchy.delete();
    contours.delete();
  }

  _score(raw, w, h, prev) {
    const out = [];
    for (const pts of raw) {
      const r = this._evaluate(pts, w, h, prev);
      if (r) out.push(r);
    }
    out.sort((a, b) => b.score - a.score);
    const unique = [];
    for (const c of out) {
      if (unique.some((u) => avgCornerDistance(u.pts, c.pts) < 0.03)) continue;
      unique.push(c);
      if (unique.length >= 8) break;
    }
    return unique;
  }

  _merge(a, b) {
    const all = a.concat(b).sort((x, y) => y.score - x.score);
    const unique = [];
    for (const c of all) {
      if (unique.some((u) => avgCornerDistance(u.pts, c.pts) < 0.03)) continue;
      unique.push(c);
      if (unique.length >= 8) break;
    }
    return unique;
  }

  _evaluate(pts, w, h, prev) {
    const q = orderQuad(pts);
    const area = Math.abs(shoelace(q));
    const rel = area / (w * h);
    if (rel < 0.015 || rel > 0.96) return null;

    const sides = [
      dist(q[0], q[1]),
      dist(q[1], q[2]),
      dist(q[2], q[3]),
      dist(q[3], q[0]),
    ];
    if (Math.min(...sides) < 16) return null;

    const ratioA = Math.min(sides[0], sides[2]) / Math.max(sides[0], sides[2]);
    const ratioB = Math.min(sides[1], sides[3]) / Math.max(sides[1], sides[3]);
    if (ratioA < 0.55 || ratioB < 0.55) return null;

    if (Math.max(...cornerCosines(q)) > 0.55) return null;

    const qw = (sides[0] + sides[2]) / 2;
    const qh = (sides[1] + sides[3]) / 2;
    const rect = area / (qw * qh);
    if (rect < 0.66) return null;

    const aspect = qw / qh;
    if (aspect < 0.3 || aspect > 3.3) return null;

    const common = [1.7778, 1.6, 1.3333, 2.3333, 1.5, 0.5625, 0.625, 0.75, 1];
    let nearest = 1;
    for (const c of common) nearest = Math.min(nearest, Math.abs(Math.log(aspect / c)));
    const aspectBonus = 1 + 0.1 * Math.exp(-nearest * 6);

    let score =
      Math.pow(rel, 0.55) *
      rect *
      (0.6 + 0.4 * ratioA) *
      (0.6 + 0.4 * ratioB) *
      aspectBonus;

    if (prev) {
      const norm = q.map((p) => ({ x: p.x / w, y: p.y / h }));
      const move = avgCornerDistance(prev, norm);
      score *= 1 + 0.7 * Math.max(0, 1 - move / 0.22);
    }

    return {
      pts: q.map((p) => ({ x: p.x / w, y: p.y / h })),
      score,
      aspect,
      rel,
    };
  }

  dispose() {
    for (const m of [this.rgba, this.gray, this.blur, this.edges, this.kernel]) m && m.delete();
    this.rgba = this.gray = this.blur = this.edges = this.kernel = null;
    this.w = this.h = 0;
  }
}

/* ------------------------------------------------------------------ */
/* warper                                                              */
/* ------------------------------------------------------------------ */

export class Warper {
  constructor(canvas) {
    this.canvas = canvas;
    this.aspect = 'auto';
    this.outW = 0;
    this.outH = 0;
    this.srcCanvas = document.createElement('canvas');
    this.srcCtx = this.srcCanvas.getContext('2d', { willReadFrequently: true });
    this.outCtx = canvas.getContext('2d');
    this.imageData = null;
    this.srcMat = null;
    this.srcW = 0;
    this.srcH = 0;
    this.srcTri = null;
    this.dstTri = null;
    this.out = null;
    this.dsize = null;
    this.ready = false;
  }

  setAspect(aspect) {
    this.aspect = aspect;
    this.outW = 0;
    this.outH = 0;
  }

  reset() {
    this.outW = 0;
    this.outH = 0;
  }

  _targetSize(corners, vw, vh) {
    const q = corners.map((p) => ({ x: p.x * vw, y: p.y * vh }));
    const wTop = dist(q[0], q[1]);
    const wBot = dist(q[3], q[2]);
    const hLeft = dist(q[0], q[3]);
    const hRight = dist(q[1], q[2]);
    let w = Math.max(2, (wTop + wBot) / 2);
    let h = Math.max(2, (hLeft + hRight) / 2);
    this.contentAspect = w / h;

    const fixed = this.aspect === 'auto' ? null : Number(this.aspect);
    if (fixed) {
      // Keep the rectified screen's long side as the output long side so we do
      // not lose resolution; the content is letterboxed inside this frame.
      const longSide = Math.max(w, h);
      if (fixed >= 1) { w = longSide; h = longSide / fixed; }
      else { h = longSide; w = longSide * fixed; }
    }

    const scale = Math.min(1, MAX_OUT / Math.max(w, h));
    w *= scale;
    h *= scale;
    w = clamp(Math.round(w / 2) * 2, 160, MAX_OUT);
    h = clamp(Math.round(h / 2) * 2, 90, MAX_OUT);
    return { w, h };
  }

  render(video, corners, forceResize = false) {
    const cv = window.cv;
    if (!cv || !corners) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const target = this._targetSize(corners, vw, vh);
    let resized = false;
    if (
      !this.outW ||
      forceResize ||
      Math.abs(target.w - this.outW) > Math.max(12, this.outW * 0.12) ||
      Math.abs(target.h - this.outH) > Math.max(12, this.outH * 0.12)
    ) {
      this.outW = target.w;
      this.outH = target.h;
      this.canvas.width = target.w;
      this.canvas.height = target.h;
      resized = true;
    }

    // Only read back the bounding box of the detected screen. This keeps the
    // getImageData cost proportional to the crop instead of the whole frame.
    const xs = corners.map((p) => p.x * vw);
    const ys = corners.map((p) => p.y * vh);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 3);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 3);
    const x1 = Math.min(vw, Math.ceil(Math.max(...xs)) + 3);
    const y1 = Math.min(vh, Math.ceil(Math.max(...ys)) + 3);
    const bw = Math.max(2, x1 - x0);
    const bh = Math.max(2, y1 - y0);

    const scale = Math.min(1, MAX_SRC / Math.max(bw, bh));
    const sw = Math.max(2, Math.round(bw * scale));
    const sh = Math.max(2, Math.round(bh * scale));
    if (this.srcCanvas.width !== sw || this.srcCanvas.height !== sh) {
      this.srcCanvas.width = sw;
      this.srcCanvas.height = sh;
    }
    this.srcCtx.drawImage(video, x0, y0, bw, bh, 0, 0, sw, sh);
    const img = this.srcCtx.getImageData(0, 0, sw, sh);

    if (!this.srcMat || this.srcMat.cols !== sw || this.srcMat.rows !== sh) {
      if (this.srcMat) this.srcMat.delete();
      this.srcMat = new cv.Mat(sh, sw, cv.CV_8UC4);
    }
    this.srcMat.data.set(img.data);

    if (!this.srcTri) {
      this.srcTri = new cv.Mat(4, 1, cv.CV_32FC2);
      this.dstTri = new cv.Mat(4, 1, cv.CV_32FC2);
    }
    if (!this.out || this.out.cols !== this.outW || this.out.rows !== this.outH) {
      if (this.out) this.out.delete();
      this.out = new cv.Mat(this.outH, this.outW, cv.CV_8UC4);
      this.dsize = new cv.Size(this.outW, this.outH);
    }

    // Fit the rectified screen inside the output frame without stretching:
    // a fixed aspect adds black bars, auto fills the frame exactly.
    const ca = this.contentAspect || this.outW / this.outH;
    const oa = this.outW / this.outH;
    const letterbox = this.aspect !== 'auto';
    let dw = this.outW;
    let dh = this.outH;
    if (letterbox && ca > oa) dh = Math.max(2, Math.round(this.outW / ca));
    else if (letterbox && ca < oa) dw = Math.max(2, Math.round(this.outH * ca));
    const ox = (this.outW - dw) / 2;
    const oy = (this.outH - dh) / 2;
    this.dstTri.data32F.set([ox, oy, ox + dw, oy, ox + dw, oy + dh, ox, oy + dh]);

    const q = corners;
    this.srcTri.data32F.set([
      (q[0].x * vw - x0) * scale, (q[0].y * vh - y0) * scale,
      (q[1].x * vw - x0) * scale, (q[1].y * vh - y0) * scale,
      (q[2].x * vw - x0) * scale, (q[2].y * vh - y0) * scale,
      (q[3].x * vw - x0) * scale, (q[3].y * vh - y0) * scale,
    ]);

    const m = cv.getPerspectiveTransform(this.srcTri, this.dstTri);
    cv.warpPerspective(
      this.srcMat,
      this.out,
      m,
      this.dsize,
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(0, 0, 0, 255)
    );
    m.delete();

    // Reuse one ImageData instead of letting cv.imshow allocate per frame.
    if (!this.imageData || this.imageData.width !== this.outW || this.imageData.height !== this.outH) {
      this.imageData = new ImageData(this.outW, this.outH);
    }
    this.imageData.data.set(this.out.data);
    this.outCtx.putImageData(this.imageData, 0, 0);

    this.ready = true;
    return { w: this.outW, h: this.outH, resized };
  }
}
