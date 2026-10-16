import type { PDFDocumentProxy } from 'pdfjs-dist';
import { convertPdf, type ConvertOptions, type Platform } from './engine';
import { detectKind, docxToMarkdown, htmlToMarkdown, imagesToPdfBytes, markdownToBlocks, textToBlocks } from './inputs';
import type { ConvertedDocument } from './types';

export interface ConvertDeps {
  platform: Platform;
  openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy>;
  /** Converte formatos que o PDF não aceita direto (WebP, GIF, BMP, TIFF) em PNG. */
  toPngOrJpg(bytes: Uint8Array, name: string): Promise<{ bytes: Uint8Array; type: 'png' | 'jpg' }>;
}

const baseTitle = (name: string) => name.replace(/\.[^.]+$/, '');

/** Converte qualquer arquivo aceito para a estrutura de blocos. */
export async function convertInput(
  file: { name: string; bytes: Uint8Array; mime?: string },
  deps: ConvertDeps,
  opts: ConvertOptions,
): Promise<ConvertedDocument> {
  const kind = detectKind(file.name, file.mime);
  const title = baseTitle(file.name);
  const simple = (blocks: ConvertedDocument['blocks']): ConvertedDocument => ({ title, blocks, ocrPages: [], ocrImages: 0, pageCount: 1 });
  switch (kind) {
    case 'pdf': {
      const doc = await deps.openPdf(file.bytes);
      try {
        return await convertPdf(doc, deps.platform, opts, title);
      } finally {
        void doc.loadingTask.destroy();
      }
    }
    case 'image': {
      // Foto ou print: vira uma página e passa pelo OCR (mantendo a estrutura do texto).
      const img = await deps.toPngOrJpg(file.bytes, file.name);
      const doc = await deps.openPdf(await imagesToPdfBytes([img]));
      try {
        return await convertPdf(doc, deps.platform, { ...opts, ocr: opts.ocr === 'never' ? 'auto' : opts.ocr, images: false }, title);
      } finally {
        void doc.loadingTask.destroy();
      }
    }
    case 'docx':
      return simple(markdownToBlocks(await docxToMarkdown(file.bytes)));
    case 'html':
      return simple(markdownToBlocks(await htmlToMarkdown(new TextDecoder().decode(file.bytes))));
    case 'markdown':
      return simple(markdownToBlocks(new TextDecoder().decode(file.bytes)));
    case 'text':
      return simple(textToBlocks(new TextDecoder().decode(file.bytes)));
    default:
      throw new Error(`Formato não suportado: ${file.name}`);
  }
}
