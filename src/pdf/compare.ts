import { diffArrays } from 'diff';
import { pageLines } from './convert';
import type { PDFDocumentProxy } from './pdfjs';

export interface Change {
  value: string;
  added?: boolean;
  removed?: boolean;
}

/** Diferença por palavras inteiras ("1.000,00" é uma unidade, não três). */
function diffWords(a: string, b: string): Change[] {
  const tok = (s: string) => s.split(/(\s+)/).filter(Boolean);
  return diffArrays(tok(a), tok(b)).map((c) => ({ value: c.value.join(''), added: c.added, removed: c.removed }));
}

export interface PageDiff {
  page: number;
  changes: Change[];
  added: number;
  removed: number;
}

async function allText(view: PDFDocumentProxy): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < view.numPages; i++) {
    out.push((await pageLines(view, i)).map((l) => l.text).join('\n'));
  }
  return out;
}

/** Compara o texto de dois documentos página a página. */
export async function compareDocuments(a: PDFDocumentProxy, b: PDFDocumentProxy): Promise<PageDiff[]> {
  const [ta, tb] = await Promise.all([allText(a), allText(b)]);
  const n = Math.max(ta.length, tb.length);
  const result: PageDiff[] = [];
  for (let i = 0; i < n; i++) {
    const changes = diffWords(ta[i] ?? '', tb[i] ?? '');
    const count = (c: Change[]) => c.reduce((s, x) => s + x.value.split(/\s+/).filter(Boolean).length, 0);
    result.push({
      page: i,
      changes,
      added: count(changes.filter((c) => c.added)),
      removed: count(changes.filter((c) => c.removed)),
    });
  }
  return result;
}
