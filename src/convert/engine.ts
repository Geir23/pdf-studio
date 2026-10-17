// Conversor: PDF → blocos estruturados, com OCR automático onde o texto não é confiável.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { applyLinks, extractPage, garbageRatio, textLength } from './extract';
import { bodyFontSize, finalizeBlocks, findRepeated, layoutPage } from './layout';
import type { Block, ConvertedDocument, PageData, Rect, TextPiece } from './types';

/** Imagem rasterizada de uma página (o navegador usa canvas; os testes, @napi-rs/canvas). */
export interface Raster {
  width: number;
  height: number;
  /**
   * PNG da página inteira ou de um recorte (em pixels). forOcr: apaga bordas de tabela antes;
   * maxSide: reduz o recorte para no máximo esse lado (imagens extraídas ficam leves);
   * jpeg: qualidade 0–1 para gerar JPEG em vez de PNG (fotos ficam ~10× menores).
   */
  png(rect?: Rect, opts?: { forOcr?: boolean; maxSide?: number; jpeg?: number }): Promise<Uint8Array>;
  /** Fração de fundo liso no recorte (0–1); ver backgroundShare. */
  backgroundShare(rect: Rect): number;
  /** Libera a memória da imagem (canvas). */
  dispose(): void;
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
  /** Quantas páginas processar ao mesmo tempo (= reconhecedores de OCR em paralelo). */
  concurrency?: number;
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
  /** Máximo de imagens lidas por OCR por documento (PDFs com centenas de fotos ficariam horas). */
  maxImageOcr: number;
  onProgress?: (msg: string, fraction: number) => void;
  signal?: AbortSignal;
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  ocr: 'auto', ocrImages: true, langs: 'por+eng', images: true, removeHeaders: true, dpi: 300, maxImageOcr: 150,
};

/** Limites de tamanho da imagem renderizada (páginas enormes não podem estourar a memória). */
const MAX_SIDE = 4600;
const MAX_PIXELS = 16_000_000;
const IMAGE_OCR_DPI = 220;
const IMAGE_EXPORT_MAX_SIDE = 1400;

export class ConversionCancelled extends Error {
  constructor() {
    super('Conversão cancelada.');
  }
}

/** Escala para renderizar uma página no dpi pedido, respeitando os limites de tamanho. */
export function safeScale(width: number, height: number, dpi: number): number {
  let s = dpi / 72;
  s = Math.min(s, MAX_SIDE / Math.max(width, height));
  s = Math.min(s, Math.sqrt(MAX_PIXELS / (width * height)));
  return Math.max(0.5, s);
}

/** Executa tarefas com no máximo `limit` ao mesmo tempo. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const run = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
}

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
  const pages: PageData[] = new Array(n);
  const pageImages: { rect: Rect; block: Block }[][] = new Array(n);
  const ocrPages: ConvertedDocument['ocrPages'] = [];
  let ocrImages = 0;
  let imageOcrBudget = opts.ocrImages && opts.ocr !== 'never' ? opts.maxImageOcr : 0;
  let imageOcrLimited = false;
  let done = 0;
  const check = () => {
    if (opts.signal?.aborted) throw new ConversionCancelled();
  };

  const processPage = async (i: number) => {
    check();
    const { data, page } = await extractPage(doc, i);
    const pageArea = data.width * data.height;
    const text = textLength(data.items);
    const garbled = text > 20 && garbageRatio(data.items) > 0.15;
    const scanned = text < 25;
    const fullOcr = opts.ocr === 'always' || (opts.ocr === 'auto' && (scanned || garbled));
    // Imagens relevantes (ignora ícones e a própria "foto" da página escaneada).
    const relevant = data.images.filter((r) => area(r) > pageArea * 0.012 && r.w > 36 && r.h > 18 && area(r) < pageArea * 0.8);
    const ocrCandidates = fullOcr || !opts.ocrImages || opts.ocr === 'never' ? [] : relevant.filter((r) => area(r) > pageArea * 0.03);
    const needRaster = fullOcr || ocrCandidates.length > 0 || (opts.images && relevant.length > 0);

    let raster: Raster | null = null;
    const blocks: { rect: Rect; block: Block }[] = [];
    try {
      if (needRaster) {
        const dpi = fullOcr ? opts.dpi : ocrCandidates.length ? IMAGE_OCR_DPI : 150;
        const scale = safeScale(data.width, data.height, dpi);
        check();
        raster = await platform.render(page, scale);
        const r0 = raster;
        // Fotos (sem fundo liso) não passam pelo OCR nem gastam o limite de imagens.
        const ocrThese = ocrCandidates.filter((rect) => {
          const px = { x: rect.x * scale, y: rect.y * scale, w: rect.w * scale, h: rect.h * scale };
          if (r0.backgroundShare(px) < 0.45) return false;
          if (imageOcrBudget <= 0) {
            imageOcrLimited = true;
            return false;
          }
          imageOcrBudget--;
          return true;
        });
        if (fullOcr) {
          const result = await platform.recognize(await raster.png(undefined, { forOcr: true }), opts.langs);
          check();
          const pieces = ocrToPieces(result, scale);
          if (pieces.length || garbled) {
            // Texto sobre imagens conhecidas (gráficos) não vira título.
            for (const it of pieces) {
              if (data.images.some((im) => area(im) < pageArea * 0.8 && it.x0 >= im.x - 1 && it.x1 <= im.x + im.w + 1 && it.baseline >= im.y && it.baseline <= im.y + im.h)) it.fromImage = true;
            }
            data.items = pieces;
            applyLinks(data);
            ocrPages.push({ page: i, reason: garbled ? 'texto-ilegivel' : 'escaneada' });
          }
        }
        for (const rect of ocrThese) {
          check();
          const px = { x: Math.max(0, rect.x * scale), y: Math.max(0, rect.y * scale), w: rect.w * scale, h: rect.h * scale };
          const result = await platform.recognize(await raster.png(px, { forOcr: true }), opts.langs);
          const pieces = ocrToPieces(result, scale, { x: px.x / scale, y: px.y / scale }, 55).map((p) => ({ ...p, fromImage: true }));
          const letters = pieces.reduce((sum, p) => sum + (p.str.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);
          // Só aceita se for texto de verdade (fotos geram "texto" de baixa confiança).
          if (letters >= 4 && meanConfidence(result) >= 60) {
            // Remove trechos do PDF que já estavam sobre a imagem (evita duplicar).
            data.items = data.items.filter((it) => !(it.x0 >= rect.x - 1 && it.x1 <= rect.x + rect.w + 1 && it.baseline >= rect.y && it.baseline <= rect.y + rect.h));
            data.items.push(...pieces);
            ocrImages++;
          }
        }
        if (opts.images) {
          let k = 0;
          for (const rect of relevant) {
            k++;
            const px = { x: Math.max(0, rect.x * scale), y: Math.max(0, rect.y * scale), w: rect.w * scale, h: rect.h * scale };
            // Foto → JPEG (leve); gráfico, print ou desenho → PNG (nítido).
            const photo = raster.backgroundShare(px) < 0.45;
            const data = await raster.png(px, { maxSide: IMAGE_EXPORT_MAX_SIDE, jpeg: photo ? 0.85 : undefined });
            const name = `pagina${i + 1}-imagem${k}.${photo ? 'jpg' : 'png'}`;
            blocks.push({ rect, block: { type: 'image', name, alt: `Imagem ${k} da página ${i + 1}`, page: i, rect, data, mime: photo ? 'image/jpeg' : 'image/png' } });
          }
        }
      }
    } finally {
      raster?.dispose();
      // Libera as imagens e fontes que o pdf.js guardou para esta página.
      page.cleanup();
    }
    pages[i] = data;
    pageImages[i] = blocks;
    done++;
    opts.onProgress?.(`Página ${done} de ${n}${ocrPages.length ? ` · OCR em ${ocrPages.length}` : ''}`, done / n);
  };

  await pool(Array.from({ length: n }, (_, i) => i), platform.concurrency ?? 1, processPage);
  check();
  ocrPages.sort((a, b) => a.page - b.page);

  opts.onProgress?.('Montando a estrutura do documento…', 0.99);
  const repeated = opts.removeHeaders ? findRepeated(pages) : new Set<string>();
  const body = bodyFontSize(pages);
  const blocks: Block[] = [];
  pages.forEach((p, i) => blocks.push(...layoutPage(p, repeated, body, pageImages[i])));
  return { title, blocks: finalizeBlocks(blocks), ocrPages, ocrImages, imageOcrLimited, pageCount: n };
}
