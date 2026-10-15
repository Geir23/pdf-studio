import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { pdfjs, type PDFDocumentProxy } from './pdfjs';
import type { FontFamily } from './types';

export interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
  str: string;
  size: number;
  font: FontFamily;
}

const cache = new WeakMap<PDFDocumentProxy, Map<number, Promise<TextBox[]>>>();

/** Caixas dos trechos de texto da página (espaço de visualização, escala 1). */
export function getTextBoxes(view: PDFDocumentProxy, index: number): Promise<TextBox[]> {
  let perDoc = cache.get(view);
  if (!perDoc) cache.set(view, (perDoc = new Map()));
  let p = perDoc.get(index);
  if (!p) {
    p = load(view, index);
    perDoc.set(index, p);
  }
  return p;
}

async function load(view: PDFDocumentProxy, index: number): Promise<TextBox[]> {
  const page = await view.getPage(index + 1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const boxes: TextBox[] = [];
  for (const raw of content.items) {
    if (!('str' in raw)) continue;
    const it = raw as TextItem;
    if (!it.str.trim()) continue;
    const tx = pdfjs.Util.transform(viewport.transform, it.transform);
    if (Math.abs(tx[1]) > 0.01 || tx[0] <= 0) continue; // só texto horizontal
    const size = Math.hypot(tx[2], tx[3]);
    const style = content.styles[it.fontName];
    const ascent = style?.ascent ? style.ascent : style?.descent ? 1 + style.descent : 0.8;
    const family = style?.fontFamily ?? '';
    const font: FontFamily = /mono/i.test(family) ? 'Courier' : /serif/i.test(family) && !/sans/i.test(family) ? 'Times' : 'Helvetica';
    const w = it.width * (tx[0] / Math.hypot(it.transform[0], it.transform[1]) || 1);
    boxes.push({ x: tx[4], y: tx[5] - size * ascent, w, h: size * 1.15, str: it.str, size, font });
  }
  return boxes;
}

/** Agrupa as caixas que cruzam um retângulo, uma faixa por linha (para marca-texto). */
export function linesInRect(boxes: TextBox[], r: { x: number; y: number; w: number; h: number }) {
  const hits = boxes.filter((b) => {
    const overlapY = Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y);
    const overlapX = Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x);
    return overlapX > 0 && overlapY > b.h * 0.4;
  });
  const lines: { x: number; y: number; w: number; h: number }[] = [];
  for (const b of hits.sort((a, c) => a.y - c.y)) {
    const line = lines.find((l) => Math.abs(l.y - b.y) < b.h * 0.5);
    const x0 = Math.max(b.x, r.x);
    const x1 = Math.min(b.x + b.w, r.x + r.w);
    if (line) {
      const nx0 = Math.min(line.x, x0);
      line.w = Math.max(line.x + line.w, x1) - nx0;
      line.x = nx0;
      line.h = Math.max(line.h, b.h);
    } else {
      lines.push({ x: x0, y: b.y, w: x1 - x0, h: b.h });
    }
  }
  return lines;
}
