import fontkit from '@pdf-lib/fontkit';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { flattenObjects } from '../../src/pdf/flatten';
import type { Box, TextObject } from '../../src/pdf/types';
import { pagesText, writeTmp } from './helpers';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', name)));

interface Word { x0: number; y0: number; x1: number; y1: number; text: string }

/** Caixas das palavras segundo o poppler (topo-esquerda, em pontos). */
function words(bytes: Uint8Array): Word[] {
  const xml = execFileSync('pdftotext', ['-bbox', writeTmp(bytes), '-'], { encoding: 'utf8' });
  return [...xml.matchAll(/xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</g)].map((m) => ({
    x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: m[5],
  }));
}

function coverOf(ws: Word[]): Box {
  const pad = 1.5;
  const x0 = Math.min(...ws.map((w) => w.x0)) - pad;
  const y0 = Math.min(...ws.map((w) => w.y0)) - pad;
  const x1 = Math.max(...ws.map((w) => w.x1)) + pad;
  const y1 = Math.max(...ws.map((w) => w.y1)) + pad;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function replacement(cover: Box, text: string): TextObject {
  return { id: 'r', page: 0, kind: 'text', ...cover, text, size: 12, color: '#000000', font: 'Helvetica',
    bold: false, italic: false, bg: '#ffffff', cover, nowrap: true };
}

describe('editar texto existente remove o original', () => {
  it('PDF do LibreOffice (TrueType embutida)', async () => {
    const pdf = fixture('libreoffice-truetype.pdf');
    const line = words(pdf).filter((w) => Math.abs(w.y0 - 56.5) < 1);
    const out = await flattenObjects(pdf, [replacement(coverOf(line), 'O valor do aluguel é R$ 2.000,00 por mês.')]);
    const text = pagesText(out)[0];
    expect(text).toContain('R$ 2.000,00');
    expect(text).not.toContain('1.000,00');
    expect(text).toContain('Primeira linha do contrato de locação.');
    expect(text).toContain('Terceira linha permanece intacta – São Paulo.');
  });

  it('nunca apaga texto fora da área escolhida', async () => {
    const pdf = fixture('libreoffice-unicode.pdf');
    const all = words(pdf);
    const value = all.filter((w) => w.text === '7.777,00');
    const out = await flattenObjects(pdf, [replacement(coverOf(value), '8.888,00')]);
    const text = pagesText(out)[0];
    expect(text).toContain('8.888,00');
    for (const w of ['Cabeçalho', 'Ελληνικά', 'Русский', '漢字', 'Valor', 'contratado:', 'conforme', 'anexo.', 'Rodapé']) {
      expect(text).toContain(w);
    }
  });

  it('mantém a posição do texto seguinte na mesma linha', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 200]);
    page.drawText('x', { font: await doc.embedFont(StandardFonts.Helvetica), size: 1, x: -10, y: -10 });
    const fontName = (page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0] as PDFName).asString();
    const content = `BT ${fontName} 12 Tf 50 100 Td (Antes ) Tj (ALVO) Tj ( depois) Tj ET`;
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
    const pdf = await doc.save();
    const before = words(pdf);
    const alvo = before.filter((w) => w.text.includes('ALVO'));
    const out = await flattenObjects(pdf, [replacement(coverOf(alvo), 'NOVO')]);
    const after = words(out);
    const depois = (ws: Word[]) => ws.find((w) => w.text === 'depois')!;
    expect(after.some((w) => w.text.includes('ALVO'))).toBe(false);
    expect(after.some((w) => w.text.includes('NOVO'))).toBe(true);
    expect(Math.abs(depois(after).x0 - depois(before).x0)).toBeLessThan(0.5);
  });

  it('fonte Type0 (Unicode, Identity-H)', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fixture('DejaVuSans.ttf'));
    const page = doc.addPage([400, 200]);
    page.drawText('Linha de cima', { x: 40, y: 150, size: 12, font });
    page.drawText('Valor: R$ 3.333,00 – ção', { x: 40, y: 120, size: 12, font });
    page.drawText('Linha de baixo', { x: 40, y: 90, size: 12, font });
    const pdf = await doc.save();
    const target = words(pdf).filter((w) => Math.abs(w.y1 - 80) < 4);
    expect(target.length).toBeGreaterThan(0);
    const out = await flattenObjects(pdf, [replacement(coverOf(target), 'Valor: R$ 4.444,00')]);
    const text = pagesText(out)[0];
    expect(text).not.toContain('3.333,00');
    expect(text).toContain('4.444,00');
    expect(text).toContain('Linha de cima');
    expect(text).toContain('Linha de baixo');
  });
});

describe('fontes embutidas no texto novo', () => {
  it('embute a fonte e preserva acentos, grego e cirílico', async () => {
    const pdf = fixture('libreoffice-truetype.pdf');
    const out = await flattenObjects(pdf, [
      { id: 't', page: 0, kind: 'text', x: 60, y: 200, w: 400, h: 30, text: 'Ação – Ελληνικά Русский €', size: 14,
        color: '#000000', font: 'Times', bold: true, italic: false, bg: null },
    ]);
    expect(pagesText(out)[0]).toContain('Ação – Ελληνικά Русский €');
    const fonts = execFileSync('pdffonts', [writeTmp(out)], { encoding: 'utf8' });
    const liberation = fonts.split('\n').find((l) => l.includes('LiberationSerif'));
    expect(liberation).toBeDefined();
    expect(liberation).toMatch(/\byes\b/); // embutida
  });
});
