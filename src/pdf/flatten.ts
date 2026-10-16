import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  PDFHexString,
  PDFPage,
  PDFString,
  degrees,
} from 'pdf-lib';
import { dataUrlMime, dataUrlToBytes } from '../lib/bytes';
import { hexToArray, hexToRgb } from '../lib/color';
import { pageGeom, placeBox, toPdf, type PageGeom } from './coords';
import { removeTextInRects } from './contentText';
import { addFormField, addLink } from './fields';
import { BASELINE, FontCache, LINE_HEIGHT, safeText, wrapText } from './fonts';
import type { EditObject, NoteObject, TextObject } from './types';

/**
 * Grava os objetos de edição no conteúdo do PDF. Tarjas de redação ("redact") são
 * apenas desenhadas aqui; a remoção real do conteúdo por baixo é feita em redact.ts.
 */
export async function flattenObjects(bytes: Uint8Array, objects: EditObject[]): Promise<Uint8Array> {
  if (objects.length === 0) return bytes;
  const doc = await PDFDocument.load(bytes);
  const fonts = new FontCache(doc);
  const pages = doc.getPages();

  // Edição de texto existente: remove do conteúdo o trecho original antes de desenhar o novo.
  pages.forEach((page, i) => {
    const g = pageGeom(page);
    const rects = objects
      .filter((o): o is TextObject => o.kind === 'text' && o.page === i && !!o.cover)
      .map((o) => {
        const a = toPdf(g, o.cover!.x, o.cover!.y);
        const b = toPdf(g, o.cover!.x + o.cover!.w, o.cover!.y + o.cover!.h);
        return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
      });
    if (rects.length) removeTextInRects(doc, page, rects);
  });

  // Ordem de pintura: coberturas primeiro, depois marcações, por fim o resto.
  const order = (o: EditObject) =>
    o.kind === 'whiteout' || o.kind === 'redact' ? 0 : o.kind === 'highlight' ? 1 : 2;
  const sorted = [...objects].sort((a, b) => order(a) - order(b));

  for (const o of sorted) {
    const page = pages[o.page];
    if (!page) continue;
    await drawObject(doc, page, pageGeom(page), o, fonts);
  }
  return doc.save();
}

async function drawObject(doc: PDFDocument, page: PDFPage, g: PageGeom, o: EditObject, fonts: FontCache) {
  const rotate = degrees(g.rot);
  switch (o.kind) {
    case 'text':
      return drawTextBox(page, g, o, fonts);

    case 'image': {
      const raw = dataUrlToBytes(o.dataUrl);
      const img = dataUrlMime(o.dataUrl) === 'image/jpeg' ? await doc.embedJpg(raw) : await doc.embedPng(raw);
      const a = placeBox(g, o.x, o.y, o.h);
      page.drawImage(img, { x: a.x, y: a.y, width: o.w, height: o.h, rotate, opacity: o.opacity });
      return;
    }

    case 'rect': {
      const a = placeBox(g, o.x, o.y, o.h);
      page.drawRectangle({
        x: a.x,
        y: a.y,
        width: o.w,
        height: o.h,
        rotate,
        color: o.fill ? hexToRgb(o.fill) : undefined,
        borderColor: o.stroke ? hexToRgb(o.stroke) : undefined,
        borderWidth: o.stroke ? o.width : 0,
        opacity: o.opacity,
        borderOpacity: o.opacity,
      });
      return;
    }

    case 'ellipse': {
      const c = toPdf(g, o.x + o.w / 2, o.y + o.h / 2);
      page.drawEllipse({
        x: c.x,
        y: c.y,
        xScale: o.w / 2,
        yScale: o.h / 2,
        rotate,
        color: o.fill ? hexToRgb(o.fill) : undefined,
        borderColor: o.stroke ? hexToRgb(o.stroke) : undefined,
        borderWidth: o.stroke ? o.width : 0,
        opacity: o.opacity,
        borderOpacity: o.opacity,
      });
      return;
    }

    case 'line':
    case 'arrow': {
      const style = { thickness: o.width, color: hexToRgb(o.stroke), opacity: o.opacity, lineCap: LineCapStyle.Round };
      page.drawLine({ start: toPdf(g, o.x1, o.y1), end: toPdf(g, o.x2, o.y2), ...style });
      if (o.kind === 'arrow') {
        const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
        const len = Math.max(8, o.width * 4);
        for (const side of [-1, 1]) {
          const a = ang + Math.PI - side * (Math.PI / 7);
          page.drawLine({
            start: toPdf(g, o.x2, o.y2),
            end: toPdf(g, o.x2 + Math.cos(a) * len, o.y2 + Math.sin(a) * len),
            ...style,
          });
        }
      }
      return;
    }

    case 'ink': {
      const style = { thickness: o.width, color: hexToRgb(o.stroke), opacity: o.opacity, lineCap: LineCapStyle.Round };
      for (let i = 1; i < o.points.length; i++) {
        const [x1, y1] = o.points[i - 1];
        const [x2, y2] = o.points[i];
        page.drawLine({ start: toPdf(g, x1, y1), end: toPdf(g, x2, y2), ...style });
      }
      return;
    }

    case 'highlight': {
      const a = placeBox(g, o.x, o.y, o.h);
      page.drawRectangle({
        x: a.x,
        y: a.y,
        width: o.w,
        height: o.h,
        rotate,
        color: hexToRgb(o.color),
        opacity: 0.4,
        blendMode: BlendMode.Multiply,
      });
      return;
    }

    case 'underline':
    case 'strike': {
      const yy = o.kind === 'underline' ? o.y + o.h - 1 : o.y + o.h / 2;
      page.drawLine({
        start: toPdf(g, o.x, yy),
        end: toPdf(g, o.x + o.w, yy),
        thickness: Math.max(1, o.h / 12),
        color: hexToRgb(o.color),
      });
      return;
    }

    case 'whiteout':
    case 'redact': {
      const a = placeBox(g, o.x, o.y, o.h);
      page.drawRectangle({ x: a.x, y: a.y, width: o.w, height: o.h, rotate, color: hexToRgb(o.color) });
      return;
    }

    case 'note':
      return addNoteAnnotation(doc, page, g, o);

    case 'field':
      return addFormField(doc, page, o);

    case 'link':
      return addLink(doc, page, o);
  }
}

async function drawTextBox(page: PDFPage, g: PageGeom, o: TextObject, fonts: FontCache) {
  const font = await fonts.get(o.font, o.bold, o.italic);
  if (o.bg) {
    for (const b of o.cover ? [o.cover, o] : [o]) {
      const a = placeBox(g, b.x, b.y, b.h);
      page.drawRectangle({ x: a.x, y: a.y, width: b.w, height: b.h, rotate: degrees(g.rot), color: hexToRgb(o.bg) });
    }
  }
  const text = safeText(font, o.text);
  const lines = o.nowrap ? text.split('\n') : wrapText(font, text, o.size, Math.max(o.w, o.size));
  lines.forEach((line, i) => {
    if (!line) return;
    const p = toPdf(g, o.x, o.y + i * o.size * LINE_HEIGHT + o.size * BASELINE);
    page.drawText(line, { x: p.x, y: p.y, size: o.size, font, color: hexToRgb(o.color), rotate: degrees(g.rot) });
  });
}

/** Comentários viram anotações PDF de verdade (ícone de nota), visíveis em qualquer leitor. */
function addNoteAnnotation(doc: PDFDocument, page: PDFPage, g: PageGeom, o: NoteObject) {
  const a = toPdf(g, o.x, o.y);
  const b = toPdf(g, o.x + 20, o.y + 20);
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)],
    Contents: PDFHexString.fromText(o.text),
    T: PDFHexString.fromText(o.author || 'Usuário'),
    Name: 'Comment',
    C: hexToArray(o.color),
    F: 4,
    Open: false,
    M: PDFString.fromDate(new Date()),
  });
  const ref = doc.context.register(annot);
  page.node.addAnnot(ref);
}
