// Plataforma do Conversor para os testes (Node): canvas nativo e Tesseract com modelos locais.
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker, OEM, type Worker } from 'tesseract.js';
import type { OcrPage, Platform, Raster } from '../../src/convert/engine';
import { backgroundShare, whitenRules } from '../../src/convert/preprocess';
import type { Rect } from '../../src/convert/types';

const require = createRequire(import.meta.url);
const langPath = (lang: string) => join(dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`)), '4.0.0_best_int');

function raster(canvas: Canvas): Raster {
  return {
    width: canvas.width,
    height: canvas.height,
    async png(rect?: Rect, opts?: { forOcr?: boolean; maxSide?: number; jpeg?: number }) {
      const r = rect ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
      const sw = Math.max(1, Math.round(Math.min(r.w, canvas.width - r.x)));
      const sh = Math.max(1, Math.round(Math.min(r.h, canvas.height - r.y)));
      const k = opts?.maxSide ? Math.min(1, opts.maxSide / Math.max(sw, sh)) : 1;
      const w = Math.max(1, Math.round(sw * k));
      const h = Math.max(1, Math.round(sh * k));
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.drawImage(canvas, Math.round(r.x), Math.round(r.y), sw, sh, 0, 0, w, h);
      if (opts?.forOcr) {
        const img = ctx.getImageData(0, 0, w, h);
        whitenRules(img as never);
        ctx.putImageData(img, 0, 0);
      }
      return new Uint8Array(opts?.jpeg ? await c.encode('jpeg', Math.round(opts.jpeg * 100)) : await c.encode('png'));
    },
    backgroundShare(rect: Rect) {
      const w = Math.max(1, Math.round(rect.w));
      const h = Math.max(1, Math.round(rect.h));
      const k = Math.min(1, 300 / Math.max(w, h));
      const c = createCanvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
      const ctx = c.getContext('2d');
      ctx.drawImage(canvas, Math.round(rect.x), Math.round(rect.y), w, h, 0, 0, c.width, c.height);
      return backgroundShare(ctx.getImageData(0, 0, c.width, c.height) as never);
    },
    dispose() {
      canvas.width = canvas.height = 1;
    },
  };
}

export function nodePlatform(concurrency = 2): Platform & { close(): Promise<void>; ocrCalls: number; maxParallel: number } {
  // Um conjunto de reconhecedores por idioma, como no navegador.
  const pools = new Map<string, { idle: Worker[]; all: Promise<Worker>[]; waiting: ((w: Worker) => void)[] }>();
  let active = 0;
  const acquire = async (langs: string): Promise<Worker> => {
    let pl = pools.get(langs);
    if (!pl) pools.set(langs, (pl = { idle: [], all: [], waiting: [] }));
    const idle = pl.idle.pop();
    if (idle) return idle;
    if (pl.all.length < concurrency) {
      const first = langs.split('+')[0];
      const w = createWorker(langs.split('+'), OEM.LSTM_ONLY, { langPath: langPath(first), gzip: true, cacheMethod: 'none' });
      pl.all.push(w);
      return w;
    }
    return new Promise((resolve) => pl!.waiting.push(resolve));
  };
  const release = (langs: string, w: Worker) => {
    const pl = pools.get(langs)!;
    const next = pl.waiting.shift();
    if (next) next(w);
    else pl.idle.push(w);
  };
  const p = {
    concurrency,
    ocrCalls: 0,
    maxParallel: 0,
    async render(page: pdfjs.PDFPageProxy, scale: number) {
      const vp = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx as never, canvas: canvas as never, viewport: vp }).promise;
      return raster(canvas);
    },
    async recognize(png: Uint8Array, langs: string): Promise<OcrPage> {
      p.ocrCalls++;
      const w = await acquire(langs);
      active++;
      p.maxParallel = Math.max(p.maxParallel, active);
      try {
        const { data } = await w.recognize(Buffer.from(png), {}, { blocks: true });
        return data as unknown as OcrPage;
      } finally {
        active--;
        release(langs, w);
      }
    },
    async close() {
      for (const pl of pools.values()) for (const w of pl.all) await (await w).terminate();
    },
  };
  return p;
}

export async function openFixture(bytes: Uint8Array) {
  return pdfjs.getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
}
