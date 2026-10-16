import { createWorker, OEM } from 'tesseract.js';
import {
  PDFDocument,
  TextRenderingMode,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  setTextRenderingMode,
} from 'pdf-lib';
import { pageGeom, toPdf } from './coords';
import { FontCache, safeText } from './fonts';
import { assetUrl, type PDFDocumentProxy } from './pdfjs';
import { renderPageToCanvas } from './render';

export interface OcrOptions {
  langs: string; // ex.: "por+eng"
  pages: number[];
  /** Pula páginas que já têm texto selecionável. */
  skipPagesWithText: boolean;
  dpi: number;
  onProgress?: (msg: string, fraction: number) => void;
}

export interface OcrResult {
  bytes: Uint8Array;
  text: string[]; // texto reconhecido por página processada
  processed: number[];
  skipped: number[];
}

export async function pageHasText(view: PDFDocumentProxy, index: number): Promise<boolean> {
  const page = await view.getPage(index + 1);
  const content = await page.getTextContent();
  const chars = content.items.reduce((n, it) => n + ('str' in it ? it.str.trim().length : 0), 0);
  return chars > 20;
}

export async function createOcrWorker(langs: string, onLog?: (status: string, p: number) => void) {
  return createWorker(langs.split('+'), OEM.LSTM_ONLY, {
    workerPath: assetUrl('vendor/tesseract/worker.min.js'),
    corePath: assetUrl('vendor/tesseract/core'),
    langPath: assetUrl('vendor/tessdata'),
    gzip: true,
    logger: (m) => onLog?.(m.status, m.progress),
  });
}

/** Reconhece o texto das páginas e o grava como camada invisível, tornando o PDF pesquisável. */
export async function ocrDocument(bytes: Uint8Array, view: PDFDocumentProxy, opt: OcrOptions): Promise<OcrResult> {
  const doc = await PDFDocument.load(bytes);
  // Fonte embutida: mantém o PDF apto a PDF/A e preserva acentos e outros alfabetos.
  const font = await new FontCache(doc).get('Helvetica');
  const result: OcrResult = { bytes, text: [], processed: [], skipped: [] };
  const total = opt.pages.length;
  let current = 0;
  opt.onProgress?.('Carregando o mecanismo de OCR…', 0);
  const worker = await createOcrWorker(opt.langs, (status, p) => {
    if (status === 'recognizing text') {
      opt.onProgress?.(`Reconhecendo página ${current + 1} de ${total}…`, (current + p) / total);
    }
  });
  try {
    const scale = opt.dpi / 72;
    for (const [k, i] of opt.pages.entries()) {
      current = k;
      if (opt.skipPagesWithText && (await pageHasText(view, i))) {
        result.skipped.push(i);
        continue;
      }
      opt.onProgress?.(`Reconhecendo página ${k + 1} de ${total}…`, k / total);
      const canvas = await renderPageToCanvas(view, i, scale);
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
      canvas.width = canvas.height = 0;
      result.text.push(data.text);
      result.processed.push(i);

      const page = doc.getPage(i);
      const g = pageGeom(page);
      page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            for (const word of line.words) {
              const text = safeText(font, word.text.trim());
              if (!text || word.confidence < 30) continue;
              const x0 = word.bbox.x0 / scale;
              const x1 = word.bbox.x1 / scale;
              const h = (word.bbox.y1 - word.bbox.y0) / scale;
              const natural = font.widthOfTextAtSize(text, 1);
              const size = Math.min(Math.max((x1 - x0) / natural, h * 0.6), h * 2.2);
              const bl = line.baseline;
              const baseY = bl && bl.x1 !== bl.x0
                ? (bl.y0 + ((word.bbox.x0 - bl.x0) * (bl.y1 - bl.y0)) / (bl.x1 - bl.x0)) / scale
                : word.bbox.y1 / scale;
              const p = toPdf(g, x0, baseY);
              page.drawText(text, { x: p.x, y: p.y, size, font, rotate: degrees(g.rot) });
            }
          }
        }
      }
      page.pushOperators(popGraphicsState());
    }
  } finally {
    await worker.terminate();
  }
  opt.onProgress?.('Concluído', 1);
  result.bytes = result.processed.length ? await doc.save() : bytes;
  return result;
}
