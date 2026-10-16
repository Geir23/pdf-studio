import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { readOutline, writeOutline } from '../../src/pdf/outline';
import { samplePdf } from './helpers';

/** Leitura independente dos marcadores, pelo pdf.js. */
async function pdfjsOutline(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const outline = (await doc.getOutline()) ?? [];
  const map = async (items: typeof outline): Promise<unknown[]> =>
    Promise.all(items.map(async (it) => {
      const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
      const page = dest ? await doc.getPageIndex(dest[0] as never) : null;
      return { title: it.title, page, children: await map(it.items) };
    }));
  return map(outline);
}

describe('marcadores', () => {
  it('lê os marcadores de um PDF do LibreOffice', async () => {
    const pdf = new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'libreoffice-marcadores.pdf')));
    const items = await readOutline(pdf);
    expect(items).toEqual(await pdfjsOutline(pdf));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.page !== null)).toBe(true);
  });

  it('grava, edita e remove marcadores', async () => {
    const pdf = await samplePdf(3);
    const tree = [
      { title: 'Introdução', page: 0, children: [{ title: 'Objetivo', page: 1, children: [] }] },
      { title: 'Conclusão – ç', page: 2, children: [] },
    ];
    const out = await writeOutline(pdf, tree);
    expect(await readOutline(out)).toEqual(tree);
    expect(await pdfjsOutline(out)).toEqual(tree);
    const renamed = await writeOutline(out, [{ ...tree[1], title: 'Fim' }]);
    expect(await readOutline(renamed)).toEqual([{ title: 'Fim', page: 2, children: [] }]);
    expect(await readOutline(await writeOutline(renamed, []))).toEqual([]);
  });
});
