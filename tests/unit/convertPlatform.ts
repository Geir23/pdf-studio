// Plataforma do Conversor para os testes (Node): canvas nativo e Tesseract com modelos locais.
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker, OEM, type Worker } from 'tesseract.js';
import type { OcrPage, Platform, Raster } from '../../src/convert/engine';
import { whitenRules } from '../../src/convert/preprocess';
import type { Rect } from '../../src/convert/types';

const require = createRequire(import.meta.url);
const langPath = (lang: string) => join(dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`)), '4.0.0_best_int');

function raster(canvas: Canvas): Raster {
  return {
    width: canvas.width,
    height: canvas.height,
    async png(rect?: Rect, forOcr?: boolean) {
      const r = rect ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
      const w = Math.max(1, Math.round(r.w));
      const h = Math.max(1, Math.round(r.h));
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.drawImage(canvas, Math.round(r.x), Math.round(r.y), w, h, 0, 0, w, h);
      if (forOcr) {
        const img = ctx.getImageData(0, 0, w, h);
        whitenRules(img as never);
        ctx.putImageData(img, 0, 0);
      }
      return new Uint8Array(await c.encode('png'));
    },
  };
}

export function nodePlatform(): Platform & { close(): Promise<void>; ocrCalls: number } {
  const workers = new Map<string, Promise<Worker>>();
  const getWorker = (langs: string) => {
    let w = workers.get(langs);
    if (!w) {
      // Um diretório por idioma: o Tesseract procura <langPath>/<idioma>.traineddata.gz.
      const first = langs.split('+')[0];
      w = createWorker(langs.split('+'), OEM.LSTM_ONLY, { langPath: langPath(first), gzip: true, cacheMethod: 'none' });
      workers.set(langs, w);
    }
    return w;
  };
  const p = {
    ocrCalls: 0,
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
      const worker = await getWorker(langs);
      const { data } = await worker.recognize(Buffer.from(png), {}, { blocks: true });
      return data as unknown as OcrPage;
    },
    async close() {
      for (const w of workers.values()) await (await w).terminate();
    },
  };
  return p;
}

export async function openFixture(bytes: Uint8Array) {
  return pdfjs.getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
}
