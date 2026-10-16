import fontkit from '@cantoo/fontkit';
import { PDFDocument, PDFFont, StandardFonts } from 'pdf-lib';
import type { FontFamily } from './types';

const MAP: Record<FontFamily, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  // normal, negrito, itálico, negrito+itálico
  Helvetica: [
    StandardFonts.Helvetica,
    StandardFonts.HelveticaBold,
    StandardFonts.HelveticaOblique,
    StandardFonts.HelveticaBoldOblique,
  ],
  Times: [
    StandardFonts.TimesRoman,
    StandardFonts.TimesRomanBold,
    StandardFonts.TimesRomanItalic,
    StandardFonts.TimesRomanBoldItalic,
  ],
  Courier: [
    StandardFonts.Courier,
    StandardFonts.CourierBold,
    StandardFonts.CourierOblique,
    StandardFonts.CourierBoldOblique,
  ],
};

export const CSS_FONT: Record<FontFamily, string> = {
  Helvetica: '"PDF Sans", Helvetica, Arial, sans-serif',
  Times: '"PDF Serif", "Times New Roman", Times, serif',
  Courier: '"PDF Mono", "Courier New", Courier, monospace',
};

/** Registra no navegador as mesmas fontes usadas no PDF, para a tela bater com o arquivo. */
export function registerWebFonts(urlOf: (file: string) => string) {
  const families: [string, FontFamily][] = [['PDF Sans', 'Helvetica'], ['PDF Serif', 'Times'], ['PDF Mono', 'Courier']];
  for (const [css, family] of families) {
    FILES[family].forEach((file, idx) => {
      const face = new FontFace(css, `url(${urlOf(`${file}.ttf`)})`, {
        weight: idx & 1 ? '700' : '400',
        style: idx & 2 ? 'italic' : 'normal',
      });
      document.fonts.add(face);
      void face.load().catch(() => undefined);
    });
  }
}

/** Distância do topo da linha até a linha de base, em múltiplos do tamanho da fonte. */
export const BASELINE = 0.93;
export const LINE_HEIGHT = 1.2;

const FILES: Record<FontFamily, [string, string, string, string]> = {
  Helvetica: ['LiberationSans-Regular', 'LiberationSans-Bold', 'LiberationSans-Italic', 'LiberationSans-BoldItalic'],
  Times: ['LiberationSerif-Regular', 'LiberationSerif-Bold', 'LiberationSerif-Italic', 'LiberationSerif-BoldItalic'],
  Courier: ['LiberationMono-Regular', 'LiberationMono-Bold', 'LiberationMono-Italic', 'LiberationMono-BoldItalic'],
};

type FontLoader = (file: string) => Promise<Uint8Array>;
let loader: FontLoader | null = null;
const fileCache = new Map<string, Promise<Uint8Array>>();

/**
 * Define de onde vêm os arquivos de fonte (navegador: fetch; testes: disco). Com um
 * carregador definido, o texto novo usa fontes Liberation embutidas (mesmas medidas de
 * Arial/Times/Courier), que cobrem latim, grego e cirílico e são aceitas em PDF/A.
 * Sem ele, cai nas 14 fontes padrão do PDF (só alfabeto latino básico).
 */
export function setFontLoader(fn: FontLoader | null) {
  loader = fn;
  fileCache.clear();
}

const perDoc = new WeakMap<PDFDocument, Map<string, Promise<PDFFont>>>();

export class FontCache {
  constructor(private doc: PDFDocument) {}

  get(family: FontFamily, bold = false, italic = false): Promise<PDFFont> {
    const idx = (bold ? 1 : 0) + (italic ? 2 : 0);
    let cache = perDoc.get(this.doc);
    if (!cache) perDoc.set(this.doc, (cache = new Map()));
    const key = `${family}-${idx}`;
    let f = cache.get(key);
    if (!f) {
      f = this.embed(family, idx);
      cache.set(key, f);
    }
    return f;
  }

  private async embed(family: FontFamily, idx: number): Promise<PDFFont> {
    if (loader) {
      const file = FILES[family][idx];
      let bytes = fileCache.get(file);
      if (!bytes) fileCache.set(file, (bytes = loader(`${file}.ttf`)));
      this.doc.registerFontkit(fontkit);
      return this.doc.embedFont(await bytes, { subset: true });
    }
    return this.doc.embedFont(MAP[family][idx]);
  }
}

/** Troca por "?" os caracteres que a fonte não tem (ex.: chinês nas fontes Liberation). */
export function safeText(font: PDFFont, text: string): string {
  let supported: Set<number> | null = null;
  try {
    supported = new Set(font.getCharacterSet());
  } catch {
    supported = null;
  }
  let out = '';
  for (const ch of text.normalize('NFC')) {
    if (ch === '\n') {
      out += ch;
      continue;
    }
    if (supported) {
      out += supported.has(ch.codePointAt(0)!) ? ch : '?';
      continue;
    }
    try {
      font.widthOfTextAtSize(ch, 1);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

/** Quebra o texto em linhas que caibam na largura dada. */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (line && font.widthOfTextAtSize(candidate.trimEnd(), size) > maxWidth) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = candidate;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
