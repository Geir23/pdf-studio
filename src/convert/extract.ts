import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { PageData, Rect, TextPiece } from './types';

// Códigos de operação do pdf.js (estáveis entre versões; ver OPS em pdf.mjs).
const OP = { save: 10, restore: 11, transform: 12, paintImageMaskXObject: 83, paintImageXObject: 85, paintInlineImageXObject: 86 } as const;

type M = number[];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m: M, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

interface FontInfo {
  name?: string;
  bold?: boolean;
  italic?: boolean;
  black?: boolean;
}

function fontFlags(page: PDFPageProxy, fontName: string): { bold: boolean; italic: boolean } {
  let f: FontInfo | undefined;
  try {
    f = page.commonObjs.has(fontName) ? (page.commonObjs.get(fontName) as FontInfo) : undefined;
  } catch {
    f = undefined;
  }
  const name = f?.name ?? '';
  return {
    bold: !!f?.bold || !!f?.black || /bold|black|heavy|semibold|demi|negrito/i.test(name),
    italic: !!f?.italic || /italic|oblique|it$|-it\b/i.test(name),
  };
}

export async function extractPage(doc: PDFDocumentProxy, index: number): Promise<{ data: PageData; page: PDFPageProxy }> {
  const page = await doc.getPage(index + 1);
  const vp = page.getViewport({ scale: 1 });
  // A lista de operações carrega as fontes (negrito/itálico) e diz onde estão as imagens.
  const ops = await page.getOperatorList();
  const content = await page.getTextContent();

  const items: TextPiece[] = [];
  for (const raw of content.items) {
    if (!('str' in raw)) continue;
    const it = raw as TextItem;
    if (!it.str) continue;
    const m = mul(vp.transform, it.transform);
    if (Math.abs(m[1]) > 0.01 * Math.abs(m[0]) || m[0] <= 0) continue; // ignora texto girado (marcas d'água, carimbos)
    const size = Math.hypot(m[2], m[3]) || Math.abs(m[3]) || 10;
    const scaleX = Math.hypot(it.transform[0], it.transform[1]) || 1;
    const width = it.width * (Math.abs(m[0]) / scaleX);
    items.push({ x0: m[4], x1: m[4] + width, baseline: m[5], size, str: it.str, ...fontFlags(page, it.fontName) });
  }

  const images: Rect[] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OP.save) stack.push(ctm);
    else if (fn === OP.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OP.transform) ctm = mul(ctm, ops.argsArray[i] as M);
    else if (fn === OP.paintImageXObject || fn === OP.paintInlineImageXObject || fn === OP.paintImageMaskXObject) {
      const full = mul(vp.transform, ctm);
      const pts = [apply(full, 0, 0), apply(full, 1, 0), apply(full, 0, 1), apply(full, 1, 1)];
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      if (r.w > 2 && r.h > 2) images.push(r);
    }
  }

  const links: PageData['links'] = [];
  for (const a of await page.getAnnotations()) {
    if (a.subtype !== 'Link' || !a.url) continue;
    const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
    links.push({ rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }, url: a.url });
  }
  const data: PageData = { index, width: vp.width, height: vp.height, items, images, links };
  applyLinks(data);
  return { data, page };
}

/**
 * Proporção de caracteres "impossíveis" (uso privado, substituição, controle). Alta = o PDF
 * mostra o texto certo, mas o texto extraível é lixo (fonte sem mapa Unicode correto).
 */
export function garbageRatio(items: TextPiece[]): number {
  let total = 0;
  let bad = 0;
  for (const it of items) {
    for (const ch of it.str) {
      if (/\s/.test(ch)) continue;
      total++;
      const c = ch.codePointAt(0)!;
      if ((c >= 0xe000 && c <= 0xf8ff) || c === 0xfffd || c < 0x20 || (c >= 0x7f && c < 0xa0)) bad++;
    }
  }
  return total ? bad / total : 0;
}

export function textLength(items: TextPiece[]): number {
  return items.reduce((n, i) => n + i.str.trim().length, 0);
}

/** O texto sob a área de um link ganha o endereço (vale também para o texto do OCR). */
export function applyLinks(data: PageData) {
  for (const l of data.links) {
    for (const it of data.items) {
      const cx = (it.x0 + it.x1) / 2;
      const cy = it.baseline - it.size * 0.3;
      if (cx >= l.rect.x && cx <= l.rect.x + l.rect.w && cy >= l.rect.y - 2 && cy <= l.rect.y + l.rect.h + 2) it.link = l.url;
    }
  }
}
