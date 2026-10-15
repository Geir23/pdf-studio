import JSZip from 'jszip';
import { PDFDocument, PageSizes } from 'pdf-lib';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { baseName } from '../lib/bytes';
import type { PDFDocumentProxy } from './pdfjs';
import { canvasToBlob, renderPageToCanvas } from './render';

export interface PageLine {
  text: string;
  size: number;
}

/** Texto da página agrupado em linhas, na ordem de leitura do pdf.js. */
export async function pageLines(view: PDFDocumentProxy, index: number): Promise<PageLine[]> {
  const page = await view.getPage(index + 1);
  const content = await page.getTextContent();
  const lines: PageLine[] = [];
  let text = '';
  let size = 0;
  for (const raw of content.items) {
    if (!('str' in raw)) continue;
    const it = raw as TextItem;
    text += it.str;
    size = Math.max(size, Math.hypot(it.transform[2], it.transform[3]));
    if (it.hasEOL) {
      lines.push({ text, size });
      text = '';
      size = 0;
    }
  }
  if (text) lines.push({ text, size });
  return lines;
}

export async function pdfToText(view: PDFDocumentProxy, onProgress?: (f: number) => void): Promise<string> {
  const parts: string[] = [];
  for (let i = 0; i < view.numPages; i++) {
    const lines = await pageLines(view, i);
    parts.push(`--- Página ${i + 1} ---\n` + lines.map((l) => l.text).join('\n'));
    onProgress?.((i + 1) / view.numPages);
  }
  return parts.join('\n\n');
}

export async function pdfToImages(
  view: PDFDocumentProxy,
  indices: number[],
  format: 'png' | 'jpeg',
  dpi: number,
  fileName: string,
  onProgress?: (f: number) => void,
): Promise<{ blob: Blob; name: string }> {
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const ext = format === 'png' ? 'png' : 'jpg';
  const base = baseName(fileName);
  const blobs: Blob[] = [];
  for (const [k, i] of indices.entries()) {
    const canvas = await renderPageToCanvas(view, i, dpi / 72);
    blobs.push(await canvasToBlob(canvas, mime, 0.92));
    canvas.width = canvas.height = 0;
    onProgress?.((k + 1) / indices.length);
  }
  if (blobs.length === 1) return { blob: blobs[0], name: `${base}-p${indices[0] + 1}.${ext}` };
  const zip = new JSZip();
  blobs.forEach((b, k) => zip.file(`${base}-p${indices[k] + 1}.${ext}`, b));
  return { blob: await zip.generateAsync({ type: 'blob' }), name: `${base}-imagens.zip` };
}

/**
 * Converte para Word (.docx) preservando o texto e as quebras de página. Páginas sem
 * texto (escaneadas) entram como imagem — rode o OCR antes para obter texto editável.
 */
export async function pdfToDocx(view: PDFDocumentProxy, onProgress?: (f: number) => void): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, ImageRun, PageBreak } = await import('docx');
  const children: InstanceType<typeof Paragraph>[] = [];
  for (let i = 0; i < view.numPages; i++) {
    const lines = await pageLines(view, i);
    const hasText = lines.some((l) => l.text.trim());
    if (hasText) {
      const sizes = lines.map((l) => l.size).filter(Boolean).sort((a, b) => a - b);
      const body = sizes[Math.floor(sizes.length / 2)] || 11;
      for (const l of lines) {
        const size = Math.round(Math.min(Math.max(l.size || body, 6), 48) * 2); // meio-pontos
        children.push(new Paragraph({ children: [new TextRun({ text: l.text, size, bold: l.size > body * 1.25 })] }));
      }
    } else {
      const canvas = await renderPageToCanvas(view, i, 1.5);
      const blob = await canvasToBlob(canvas, 'image/png');
      const maxW = 600;
      const ratio = canvas.height / canvas.width;
      children.push(
        new Paragraph({
          children: [
            new ImageRun({
              type: 'png',
              data: new Uint8Array(await blob.arrayBuffer()),
              transformation: { width: maxW, height: Math.round(maxW * ratio) },
            }),
          ],
        }),
      );
    }
    if (i < view.numPages - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
    onProgress?.((i + 1) / view.numPages);
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}

async function imageToEmbeddable(file: File): Promise<{ bytes: Uint8Array; kind: 'png' | 'jpg' }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type === 'image/jpeg') return { bytes, kind: 'jpg' };
  if (file.type === 'image/png') return { bytes, kind: 'png' };
  // Outros formatos (WebP, GIF, BMP…) passam pelo canvas do navegador.
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  const blob = await canvasToBlob(canvas, 'image/png');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), kind: 'png' };
}

export async function imagesToPdf(files: File[], pageSize: 'fit' | 'A4' | 'Letter', margin: number) {
  const doc = await PDFDocument.create();
  for (const file of files) {
    const { bytes, kind } = await imageToEmbeddable(file);
    const img = kind === 'jpg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    if (pageSize === 'fit') {
      const page = doc.addPage([img.width * 0.75, img.height * 0.75]); // 96 dpi → pontos
      page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      continue;
    }
    let [pw, ph] = pageSize === 'A4' ? PageSizes.A4 : PageSizes.Letter;
    if (img.width > img.height) [pw, ph] = [ph, pw];
    const page = doc.addPage([pw, ph]);
    const s = Math.min((pw - 2 * margin) / img.width, (ph - 2 * margin) / img.height);
    const w = img.width * s;
    const h = img.height * s;
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return doc.save();
}
