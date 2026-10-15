import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from './pdfjs';
import type { Box } from './types';

export async function renderPageToCanvas(
  doc: PDFDocumentProxy,
  index: number,
  scale: number,
  canvas: HTMLCanvasElement = document.createElement('canvas'),
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(index + 1);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao gerar imagem.'))), type, quality),
  );
}

export interface RasterOptions {
  dpi: number;
  quality: number; // 0..1 (JPEG)
  /** Retângulos (espaço de visualização) pintados de preto antes da conversão. */
  blackouts?: Map<number, Box[]>;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Substitui as páginas indicadas por uma imagem delas mesmas. Usado para comprimir
 * documentos escaneados e para redação segura (o texto por baixo da tarja some).
 */
export async function rasterizePages(
  bytes: Uint8Array,
  view: PDFDocumentProxy,
  indices: number[],
  opt: RasterOptions,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const scale = opt.dpi / 72;
  let done = 0;
  for (const i of indices) {
    const canvas = await renderPageToCanvas(view, i, scale);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000000';
    for (const b of opt.blackouts?.get(i) ?? []) {
      ctx.fillRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale);
    }
    const blob = await canvasToBlob(canvas, 'image/jpeg', opt.quality);
    const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const w = canvas.width / scale;
    const h = canvas.height / scale;
    const page = doc.insertPage(i, [w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    doc.removePage(i + 1);
    canvas.width = canvas.height = 0;
    opt.onProgress?.(++done, indices.length);
  }
  return doc.save({ useObjectStreams: true });
}
