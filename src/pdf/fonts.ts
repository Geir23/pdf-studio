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
  Helvetica: 'Helvetica, Arial, sans-serif',
  Times: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};

/** Distância do topo da linha até a linha de base, em múltiplos do tamanho da fonte. */
export const BASELINE = 0.93;
export const LINE_HEIGHT = 1.2;

export class FontCache {
  private cache = new Map<string, PDFFont>();
  constructor(private doc: PDFDocument) {}

  async get(family: FontFamily, bold = false, italic = false): Promise<PDFFont> {
    const name = MAP[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
    let f = this.cache.get(name);
    if (!f) {
      f = await this.doc.embedFont(name);
      this.cache.set(name, f);
    }
    return f;
  }
}

/** As fontes padrão do PDF só cobrem o alfabeto WinAnsi; troca o resto por "?". */
export function safeText(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    if (ch === '\n') {
      out += ch;
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
