import type { PDFPageProxy } from 'pdfjs-dist';
import type { Worker } from 'tesseract.js';
import { createOcrWorker } from '../pdf/ocr';
import { PasswordRequiredError, openPdf } from '../pdf/pdfjs';
import { canvasToBlob } from '../pdf/render';
import type { ConvertDeps } from './convertFile';
import type { OcrPage, Platform, Raster } from './engine';
import { backgroundShare, whitenRules } from './preprocess';
import type { Rect } from './types';

function raster(canvas: HTMLCanvasElement): Raster {
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
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: !!opts?.forOcr })!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, Math.round(r.x), Math.round(r.y), sw, sh, 0, 0, w, h);
      if (opts?.forOcr) {
        const img = ctx.getImageData(0, 0, w, h);
        whitenRules(img);
        ctx.putImageData(img, 0, 0);
      }
      const blob = await canvasToBlob(c, opts?.jpeg ? 'image/jpeg' : 'image/png', opts?.jpeg);
      c.width = c.height = 0;
      return new Uint8Array(await blob.arrayBuffer());
    },
    backgroundShare(rect: Rect) {
      const w = Math.max(1, Math.round(rect.w));
      const h = Math.max(1, Math.round(rect.h));
      const k = Math.min(1, 300 / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k));
      c.height = Math.max(1, Math.round(h * k));
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(canvas, Math.round(rect.x), Math.round(rect.y), w, h, 0, 0, c.width, c.height);
      const share = backgroundShare(ctx.getImageData(0, 0, c.width, c.height));
      c.width = c.height = 0;
      return share;
    },
    dispose() {
      canvas.width = canvas.height = 0;
    },
  };
}

/** Quantos reconhecedores de OCR rodar em paralelo (cada um usa um núcleo e ~150 MB). */
export function ocrConcurrency(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  const mem = (typeof navigator !== 'undefined' && (navigator as { deviceMemory?: number }).deviceMemory) || 8;
  return Math.max(1, Math.min(4, cores - 1, Math.floor(mem / 2)));
}

/** Plataforma do Conversor no navegador/desktop. Chame dispose() ao terminar o lote. */
export function browserPlatform(onOcrLog?: (status: string, progress: number) => void): Platform & { dispose(): Promise<void> } {
  const concurrency = ocrConcurrency();
  // Um conjunto de reconhecedores por idioma; cada pedido pega um livre.
  const pools = new Map<string, { idle: Worker[]; all: Promise<Worker>[]; waiting: ((w: Worker) => void)[] }>();
  const acquire = async (langs: string): Promise<Worker> => {
    let p = pools.get(langs);
    if (!p) pools.set(langs, (p = { idle: [], all: [], waiting: [] }));
    const idle = p.idle.pop();
    if (idle) return idle;
    if (p.all.length < concurrency) {
      const w = createOcrWorker(langs, onOcrLog);
      p.all.push(w);
      return w;
    }
    return new Promise((resolve) => p!.waiting.push(resolve));
  };
  const release = (langs: string, w: Worker) => {
    const p = pools.get(langs)!;
    const next = p.waiting.shift();
    if (next) next(w);
    else p.idle.push(w);
  };
  return {
    concurrency,
    async render(page: PDFPageProxy, scale: number) {
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
      return raster(canvas);
    },
    async recognize(png: Uint8Array, langs: string): Promise<OcrPage> {
      const w = await acquire(langs);
      try {
        const { data } = await w.recognize(new Blob([png as BlobPart], { type: 'image/png' }), {}, { blocks: true });
        return data as unknown as OcrPage;
      } finally {
        release(langs, w);
      }
    },
    async dispose() {
      for (const p of pools.values()) for (const w of p.all) await (await w).terminate().catch(() => undefined);
      pools.clear();
    },
  };
}

export function browserDeps(platform: Platform, password?: (name: string) => Promise<string | null>): ConvertDeps {
  return {
    platform,
    async openPdf(bytes) {
      try {
        return await openPdf(bytes);
      } catch (e) {
        if (!password || !(e instanceof PasswordRequiredError)) throw e;
        const pw = await password('');
        if (pw === null) throw new Error('Arquivo protegido por senha: conversão cancelada.');
        return openPdf(bytes, pw);
      }
    },
    async toPngOrJpg(bytes, name) {
      const lower = name.toLowerCase();
      if (lower.endsWith('.png')) return { bytes, type: 'png' };
      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return { bytes, type: 'jpg' };
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      const blob = await canvasToBlob(c, 'image/png');
      return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'png' };
    },
  };
}
