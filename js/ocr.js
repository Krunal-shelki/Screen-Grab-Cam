/* ScreenGrab OCR.
   Tesseract.js is loaded lazily, only when the user asks for text. The engine is
   pinned so the service worker can cache it for offline use, and a single
   worker is reused for every recognition after the first. */

const TESSERACT_VERSION = '7.0.0';
const SCRIPT_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`;
const CORE_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_VERSION}`;
const LANGUAGE = 'eng';
const MAX_SIDE = 1600;

let scriptPromise = null;
let workerPromise = null;
let statusHandler = null;

const LABELS = {
  'loading tesseract core': 'Loading OCR',
  'initializing tesseract': 'Starting OCR',
  'loading language traineddata': 'Loading language',
  'initializing api': 'Starting OCR',
  'recognizing text': 'Reading text',
};

function report(message) {
  if (!statusHandler || !message) return;
  const phase = message.status || '';
  statusHandler({
    phase,
    label: LABELS[phase] || 'Reading text',
    progress: typeof message.progress === 'number' ? message.progress : 0,
  });
}

function loadScript() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error('The OCR engine did not initialise.'));
    };
    script.onerror = () => reject(new Error('Could not download the OCR engine. Check your connection and try again.'));
    document.head.appendChild(script);
  }).catch((err) => {
    scriptPromise = null;
    throw err;
  });
  return scriptPromise;
}

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const Tesseract = await loadScript();
    const worker = await Tesseract.createWorker(LANGUAGE, 1, {
      workerPath: SCRIPT_URL.replace('tesseract.min.js', 'worker.min.js'),
      corePath: CORE_PATH,
      logger: report,
    });
    // Automatic page segmentation (PSM 3): it handled headings, labels and
    // scattered UI text better than "single uniform block" in testing.
    await worker.setParameters({ tessedit_pageseg_mode: '3' });
    return worker;
  })().catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

/* Scale up small frames (small text is the main failure mode on phones) and
   convert to grayscale, which Tesseract thresholds more reliably than colour. */
function prepare(source) {
  const scale = Math.min(2, Math.max(1, MAX_SIDE / Math.max(source.width, source.height)));
  const width = Math.max(2, Math.round(source.width * scale));
  const height = Math.max(2, Math.round(source.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);

  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    data[i] = data[i + 1] = data[i + 2] = gray;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* Recognises the text in a canvas/image. Resolves { text, confidence, ms }. */
export async function readText(source, { onStatus } = {}) {
  if (!source || !source.width || !source.height) {
    throw new Error('There is no output frame to read yet.');
  }
  const started = performance.now();
  const canvas = prepare(source);

  statusHandler = onStatus || null;
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    return {
      text: tidy(data.text),
      confidence: Math.round(data.confidence || 0),
      ms: Math.round(performance.now() - started),
    };
  } finally {
    statusHandler = null;
  }
}

export function disposeOCR() {
  const pending = workerPromise;
  workerPromise = null;
  if (pending) pending.then((worker) => worker.terminate()).catch(() => {});
}
