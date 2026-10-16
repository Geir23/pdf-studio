// Conversor: PDF → blocos estruturados, com OCR automático onde o texto não é confiável.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { applyLinks, extractPage, garbageRatio, textLength } from './extract';
import { bodyFontSize, finalizeBlocks, findRepeated, layoutPage } from './layout';
import type { Block, ConvertedDocument, PageData, Rect, TextPiece } from './types';

/** Imagem rasterizada de uma página (o navegador usa canvas; os testes, @napi-rs/canvas). */
export interface Raster {
  width: number;
  height: number;
  /** PNG da página inteira ou de um recorte (em pixels). forOcr: apaga bordas de tabela antes. */
  png(rect?: Rect, forOcr?: boolean): Promise<Uint8Array>;
}

/** Saída do Tesseract (apenas o que usamos). */
export interface OcrPage {
  blocks: {
    paragraphs: {
      lines: {
        bbox: { x0: number; y0: number; x1: number; y1: number };
        rowAttributes?: { rowHeight: number; ascenders: number; descenders: number };
        baseline?: { x0: number; y0: number; x1: number; y1: number };
        words: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[];
      }[];
    }[];
  }[] | null;
}

export interface Platform {
  render(page: PDFPageProxy, scale: number): Promise<Raster>;
  recognize(png: Uint8Array, langs: string): Promise<OcrPage>;
}

export interface ConvertOptions {
  /** auto: OCR só em páginas escaneadas ou com texto ilegível. */
  ocr: 'auto' | 'always' | 'never';
  /** Reconhecer texto dentro de imagens (gráficos, prints, fotos de documentos). */
  ocrImages: boolean;
  langs: string;
  /** Extrair as imagens como arquivos PNG. */
  images: boolean;
  removeHeaders: boolean;
  dpi: number;
  onProgress?: (msg: string, fraction: number) => void;
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  ocr: 'auto', ocrImages: true, langs: 'por+eng', images: true, removeHeaders: true, dpi: 300,
};

/** Converte linhas do Tesseract em trechos posicionados na página (pontos). */
export function ocrToPieces(ocr: OcrPage, scale: number, offset = { x: 0, y: 0 }, minConfidence = 0): TextPiece[] {
  const out: TextPiece[] = [];
  for (const b of ocr.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
    // Restos de bordas de tabela aparecem como "|" colados às palavras.
    const words = l.words
      .map((w) => ({ ...w, text: w.text.replace(/^[|¦│]+|[|¦│]+$/g, '') }))
      .filter((w) => w.text.trim() && w.confidence >= minConfidence);
    // Linhas sem nenhuma letra ou número são ruído (riscos, sujeira da digitalização).
    const alnum = words.reduce((n, w) => n + (w.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);
    if (!words.length || alnum === 0 || (alnum < 2 && words.map((w) => w.text).join('').length <= 3)) continue;
    const h = (l.bbox.y1 - l.bbox.y0) / scale;
    // rowHeight não varia com letras como "g" e "j": mede melhor o tamanho da fonte.
    const row = (l.rowAttributes?.rowHeight ?? l.bbox.y1 - l.bbox.y0) / scale;
    const size = Math.max(4, row / 1.15);
    const baseline = l.baseline && l.baseline.x1 !== l.baseline.x0
      ? (l.baseline.y0 + l.baseline.y1) / 2 / scale + offset.y
      : l.bbox.y1 / scale - h * 0.2 + offset.y;
    for (const w of words) {
      out.push({ x0: w.bbox.x0 / scale + offset.x, x1: w.bbox.x1 / scale + offset.x, baseline, size, str: w.text, bold: false, italic: false, ocr: true });
    }
  }
  return out;
}

function meanConfidence(ocr: OcrPage) {
  const ws = (ocr.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
  return ws.length ? ws.reduce((s, w) => s + w.confidence, 0) / ws.length : 0;
}

const area = (r: Rect) => r.w * r.h;

export async function convertPdf(doc: PDFDocumentProxy, platform: Platform, opts: ConvertOptions, title = 'Documento'): Promise<ConvertedDocument> {
  const n = doc.numPages;
  const pages: PageData[] = [];
  const pageImages: { rect: Rect; block: Block }[][] = [];
  const ocrPages: ConvertedDocument['ocrPages'] = [];
  let ocrImages = 0;
  const ocrScale = opts.dpi / 72;

  for (let i = 0; i < n; i++) {
    opts.onProgress?.(`Analisando página ${i + 1} de ${n}…`, i / n);
    const { data, page } = await extractPage(doc, i);
    const pageArea = data.width * data.height;
    const text = textLength(data.items);
    const garbled = text > 20 && garbageRatio(data.items) > 0.15;
    const scanned = text < 25;
    let raster: Raster | null = null;
    const getRaster = async () => (raster ??= await platform.render(page, ocrScale));

    const fullOcr = opts.ocr === 'always' || (opts.ocr === 'auto' && (scanned || garbled));
    if (fullOcr && opts.ocr !== 'never') {
      opts.onProgress?.(`Reconhecendo texto (OCR) da página ${i + 1} de ${n}…`, (i + 0.3) / n);
      const r = await getRaster();
      const result = await platform.recognize(await r.png(undefined, true), opts.langs);
      const pieces = ocrToPieces(result, ocrScale);
      if (pieces.length || garbled) {
        // Texto sobre imagens conhecidas (gráficos) não vira título.
        for (const it of pieces) {
          if (data.images.some((im) => area(im) < data.width * data.height * 0.8 && it.x0 >= im.x - 1 && it.x1 <= im.x + im.w + 1 && it.baseline >= im.y && it.baseline <= im.y + im.h)) it.fromImage = true;
        }
        data.items = pieces;
        applyLinks(data);
        ocrPages.push({ page: i, reason: garbled ? 'texto-ilegivel' : 'escaneada' });
      }
    }

    // Imagens relevantes (ignora ícones e a própria "foto" da página escaneada).
    const relevant = data.images.filter((r) => area(r) > pageArea * 0.012 && r.w > 36 && r.h > 18 && area(r) < pageArea * 0.8);
    const blocks: { rect: Rect; block: Block }[] = [];
    let k = 0;
    for (const rect of relevant) {
      k++;
      if (opts.ocrImages && opts.ocr !== 'never' && !ocrPages.some((p) => p.page === i)) {
        opts.onProgress?.(`Lendo texto da imagem ${k} da página ${i + 1}…`, (i + 0.6) / n);
        const r = await getRaster();
        const px = { x: Math.max(0, rect.x * ocrScale), y: Math.max(0, rect.y * ocrScale), w: rect.w * ocrScale, h: rect.h * ocrScale };
        const result = await platform.recognize(await r.png(px, true), opts.langs);
        const pieces = ocrToPieces(result, ocrScale, { x: px.x / ocrScale, y: px.y / ocrScale }, 55).map((p) => ({ ...p, fromImage: true }));
        const letters = pieces.reduce((s, p) => s + (p.str.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);
        // Só aceita se for texto de verdade (fotos geram "texto" de baixa confiança).
        if (letters >= 4 && meanConfidence(result) >= 60) {
          // Remove trechos do PDF que já estavam sobre a imagem (evita duplicar).
          data.items = data.items.filter((it) => !(it.x0 >= rect.x - 1 && it.x1 <= rect.x + rect.w + 1 && it.baseline >= rect.y && it.baseline <= rect.y + rect.h));
          data.items.push(...pieces);
          ocrImages++;
        }
      }
      if (opts.images) {
        const r = await getRaster();
        const png = await r.png({ x: rect.x * ocrScale, y: rect.y * ocrScale, w: rect.w * ocrScale, h: rect.h * ocrScale });
        const name = `pagina${i + 1}-imagem${k}.png`;
        blocks.push({ rect, block: { type: 'image', name, alt: `Imagem ${k} da página ${i + 1}`, page: i, rect, png } });
      }
    }
    pages.push(data);
    pageImages.push(blocks);
  }

  opts.onProgress?.('Montando a estrutura do documento…', 0.97);
  const repeated = opts.removeHeaders ? findRepeated(pages) : new Set<string>();
  const body = bodyFontSize(pages);
  const blocks: Block[] = [];
  pages.forEach((p, i) => blocks.push(...layoutPage(p, repeated, body, pageImages[i])));
  return { title, blocks: finalizeBlocks(blocks), ocrPages, ocrImages, pageCount: n };
}
