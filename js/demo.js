/* Synthetic camera feed used by the "Try a demo feed" link.
   Draws a monitor on a wall, slowly moving and skewed, so screen detection
   and rectification can be tried without a physical camera. */

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, rr);
  } else {
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}

function drawScene(ctx, t) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;

  // wall
  const wall = ctx.createLinearGradient(0, 0, W, H);
  wall.addColorStop(0, '#5b6b80');
  wall.addColorStop(0.5, '#3c4a5c');
  wall.addColorStop(1, '#1d2733');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, W, H);

  const light = ctx.createRadialGradient(W * 0.42, H * 0.3, 40, W * 0.42, H * 0.3, W * 0.72);
  light.addColorStop(0, 'rgba(226, 232, 240, 0.32)');
  light.addColorStop(1, 'rgba(15, 23, 42, 0)');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, W, H);

  // desk
  const desk = ctx.createLinearGradient(0, H * 0.76, 0, H);
  desk.addColorStop(0, '#2a3441');
  desk.addColorStop(1, '#0d131b');
  ctx.fillStyle = desk;
  ctx.fillRect(0, H * 0.78, W, H * 0.22);

  // subtle plant
  ctx.fillStyle = 'rgba(20, 40, 32, 0.85)';
  ctx.beginPath();
  ctx.ellipse(W * 0.09, H * 0.72, W * 0.05, H * 0.13, 0.3, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(W * 0.5 + Math.sin(t * 0.55) * 9, H * 0.44 + Math.cos(t * 0.42) * 6);
  ctx.rotate(Math.sin(t * 0.33) * 0.05);
  ctx.transform(1, 0.03 * Math.sin(t * 0.5), 0.11 * Math.sin(t * 0.4), 1, 0, 0);

  const sw = W * 0.6;
  const sh = (sw * 9) / 16;

  // stand
  ctx.fillStyle = '#0a0f16';
  ctx.fillRect(-sw * 0.055, sh / 2 + 16, sw * 0.11, H * 0.085);
  ctx.beginPath();
  ctx.ellipse(0, sh / 2 + 16 + H * 0.085, sw * 0.17, 11, 0, 0, Math.PI * 2);
  ctx.fill();

  // bezel
  roundRect(ctx, -sw / 2 - 17, -sh / 2 - 17, sw + 34, sh + 34, 16);
  ctx.fillStyle = '#04070b';
  ctx.fill();

  // screen
  const cg = ctx.createLinearGradient(-sw / 2, -sh / 2, sw / 2, sh / 2);
  cg.addColorStop(0, '#0b1420');
  cg.addColorStop(1, '#132235');
  ctx.fillStyle = cg;
  ctx.fillRect(-sw / 2, -sh / 2, sw, sh);

  // header
  const head = ctx.createLinearGradient(-sw / 2, 0, sw / 2, 0);
  head.addColorStop(0, '#0f766e');
  head.addColorStop(1, '#155e75');
  ctx.fillStyle = head;
  ctx.fillRect(-sw / 2, -sh / 2, sw, sh * 0.115);

  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ecfeff';
  ctx.font = `700 ${Math.round(sh * 0.05)}px -apple-system, system-ui, sans-serif`;
  ctx.fillText('SCREENGRAB  ·  LIVE', -sw / 2 + sw * 0.035, -sh / 2 + sh * 0.058);

  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = `600 ${Math.round(sh * 0.032)}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'right';
  ctx.fillText('OUTPUT 1280 × 720', sw / 2 - sw * 0.035, -sh / 2 + sh * 0.058);
  ctx.textAlign = 'left';

  // grid
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = -sh / 2 + sh * 0.115 + (sh * 0.885 * i) / 4;
    ctx.beginPath();
    ctx.moveTo(-sw / 2, y);
    ctx.lineTo(sw / 2, y);
    ctx.stroke();
  }

  // bars
  const bars = [0.32, 0.52, 0.44, 0.68, 0.58, 0.82, 0.71, 0.94];
  const baseY = sh * 0.34;
  const maxH = sh * 0.46;
  const bw = sw * 0.062;
  const gap = sw * 0.023;
  const startX = -sw / 2 + sw * 0.07;
  bars.forEach((v, i) => {
    const bh = maxH * v;
    const g = ctx.createLinearGradient(0, baseY, 0, baseY - bh);
    g.addColorStop(0, '#2dd4bf');
    g.addColorStop(1, '#22d3ee');
    ctx.fillStyle = g;
    roundRect(ctx, startX + i * (bw + gap), baseY - bh, bw, bh, 4);
    ctx.fill();
  });

  // stat card
  ctx.fillStyle = 'rgba(255,255,255,0.055)';
  roundRect(ctx, sw * 0.12, -sh * 0.27, sw * 0.33, sh * 0.45, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(94, 234, 212, 0.28)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = '#5eead4';
  ctx.font = `800 ${Math.round(sh * 0.145)}px -apple-system, system-ui, sans-serif`;
  ctx.fillText('98.4%', sw * 0.155, -sh * 0.055);
  ctx.fillStyle = '#94a3b8';
  ctx.font = `500 ${Math.round(sh * 0.037)}px -apple-system, system-ui, sans-serif`;
  ctx.fillText('alignment confidence', sw * 0.155, sh * 0.045);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(sw * 0.155, sh * 0.095, sw * 0.25, 3);

  // cursor
  const cx = sw * 0.3 + Math.sin(t * 0.9) * sw * 0.1;
  const cy = -sh * 0.12 + Math.cos(t * 0.7) * sh * 0.08;
  ctx.fillStyle = '#f8fafc';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + 12, cy + 26);
  ctx.lineTo(cx + 17, cy + 15);
  ctx.lineTo(cx + 28, cy + 13);
  ctx.closePath();
  ctx.fill();

  ctx.restore();

  // vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, H * 0.92);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

export function createDemoFeed() {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const started = performance.now();
  let raf = 0;
  let stopped = false;
  let lastDraw = 0;

  const tick = (now) => {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (now - lastDraw < 33) return;
    lastDraw = now;
    drawScene(ctx, (now - started) / 1000);
  };
  raf = requestAnimationFrame(tick);
  drawScene(ctx, 0);

  const stream = canvas.captureStream(30);
  return {
    stream,
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
