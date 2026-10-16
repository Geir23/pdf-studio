import type { PDFPageProxy } from 'pdfjs-dist';
import type { Worker } from 'tesseract.js';
import { createOcrWorker } from '../pdf/ocr';
import { PasswordRequiredError, openPdf } from '../pdf/pdfjs';
import { canvasToBlob } from '../pdf/render';
import type { ConvertDeps } from './convertFile';
import type { OcrPage, Platform, Raster } from './engine';
import { whitenRules } from './preprocess';
import type { Rect } from './types';

function raster(canvas: HTMLCanvasElement): Raster {
  return {
    width: canvas.width,
    height: canvas.height,
    async png(rect?: Rect, forOcr?: boolean) {
      const r = rect ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
      const w = Math.max(1, Math.round(r.w));
      const h = Math.max(1, Math.round(r.h));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: !!forOcr })!;
      ctx.drawImage(canvas, Math.round(r.x), Math.round(r.y), w, h, 0, 0, w, h);
      if (forOcr) {
        const img = ctx.getImageData(0, 0, w, h);
        whitenRules(img);
        ctx.putImageData(img, 0, 0);
      }
      const blob = await canvasToBlob(c, 'image/png');
      c.width = c.height = 0;
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}

/** Plataforma do Conversor no navegador/desktop. Chame dispose() ao terminar o lote. */
export function browserPlatform(onOcrLog?: (status: string, progress: number) => void): Platform & { dispose(): Promise<void> } {
  const workers = new Map<string, Promise<Worker>>();
  return {
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
      let w = workers.get(langs);
      if (!w) workers.set(langs, (w = createOcrWorker(langs, onOcrLog)));
      const { data } = await (await w).recognize(new Blob([png as BlobPart], { type: 'image/png' }), {}, { blocks: true });
      return data as unknown as OcrPage;
    },
    async dispose() {
      for (const w of workers.values()) await (await w).terminate().catch(() => undefined);
      workers.clear();
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
