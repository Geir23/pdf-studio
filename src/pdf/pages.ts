import { PDFDocument, PDFName, PDFNumber, PDFObject, PDFRef, PageSizes, degrees } from 'pdf-lib';
import { normRotation } from './coords';

/** Converte "1-3, 5, 8-" em índices (base 0). Lança erro com mensagem amigável. */
export function parseRanges(input: string, pageCount: number): number[] {
  const out: number[] = [];
  const text = input.trim();
  if (!text) throw new Error('Informe as páginas (ex.: 1-3, 5).');
  for (const part of text.split(/[,;]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d*)\s*-\s*(\d*)$/);
    let from: number, to: number;
    if (m) {
      from = m[1] ? parseInt(m[1], 10) : 1;
      to = m[2] ? parseInt(m[2], 10) : pageCount;
    } else if (/^\d+$/.test(p)) {
      from = to = parseInt(p, 10);
    } else {
      throw new Error(`Intervalo inválido: "${p}"`);
    }
    if (from < 1 || to > pageCount || from > to) {
      throw new Error(`Intervalo fora do documento (1-${pageCount}): "${p}"`);
    }
    for (let i = from; i <= to; i++) out.push(i - 1);
  }
  return out;
}

/** Agrupa intervalos separados por ";" ou quebra de linha, para dividir em vários arquivos. */
export function parseGroups(input: string, pageCount: number): number[][] {
  return input
    .split(/[;\n]/)
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => parseRanges(g, pageCount));
}

export async function rotatePages(bytes: Uint8Array, indices: number[], delta: number) {
  const doc = await PDFDocument.load(bytes);
  for (const i of indices) {
    const page = doc.getPage(i);
    page.setRotation(degrees(normRotation(page.getRotation().angle + delta)));
  }
  return doc.save();
}

export async function deletePages(bytes: Uint8Array, indices: number[]) {
  const doc = await PDFDocument.load(bytes);
  if (indices.length >= doc.getPageCount()) throw new Error('O documento precisa ter ao menos uma página.');
  [...new Set(indices)].sort((a, b) => b - a).forEach((i) => doc.removePage(i));
  return doc.save();
}

/** Reordena as páginas; `order[k]` é o índice antigo da página que vai para a posição k. */
export async function reorderPages(bytes: Uint8Array, order: number[]) {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  if (order.length !== pages.length || [...order].sort((a, b) => a - b).some((v, i) => v !== i)) {
    throw new Error('Ordem de páginas inválida.');
  }
  // Reescreve a árvore de páginas como uma lista simples. Atributos herdáveis dos nós
  // intermediários são copiados para cada página antes de os nós serem descartados.
  const rootRef = doc.catalog.get(PDFName.of('Pages')) as PDFRef;
  const root = doc.catalog.Pages();
  for (const page of pages) {
    const leaf = page.node;
    const inherited: [string, unknown][] = [
      ['Resources', leaf.Resources()],
      ['MediaBox', leaf.MediaBox()],
      ['CropBox', leaf.CropBox()],
      ['Rotate', leaf.Rotate()],
    ];
    for (const [key, value] of inherited) {
      if (value && !leaf.has(PDFName.of(key))) leaf.set(PDFName.of(key), value as PDFObject);
    }
    leaf.set(PDFName.of('Parent'), rootRef);
  }
  root.set(PDFName.of('Kids'), doc.context.obj(order.map((i) => pages[i].ref)));
  root.set(PDFName.of('Count'), PDFNumber.of(pages.length));
  return doc.save();
}

export async function insertBlankPage(bytes: Uint8Array, at: number, size?: [number, number]) {
  const doc = await PDFDocument.load(bytes);
  const ref = doc.getPage(Math.min(Math.max(at - 1, 0), doc.getPageCount() - 1));
  const { width, height } = ref.getSize();
  doc.insertPage(at, size ?? [width || PageSizes.A4[0], height || PageSizes.A4[1]]);
  return doc.save();
}

export async function duplicatePages(bytes: Uint8Array, indices: number[]) {
  const doc = await PDFDocument.load(bytes);
  const sorted = [...new Set(indices)].sort((a, b) => b - a);
  for (const i of sorted) {
    const [copy] = await doc.copyPages(doc, [i]);
    doc.insertPage(i + 1, copy);
  }
  return doc.save();
}

export async function extractPages(bytes: Uint8Array, indices: number[]) {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const copies = await out.copyPages(src, indices);
  copies.forEach((p) => out.addPage(p));
  return out.save();
}

/** Insere todas as páginas de outro PDF na posição `at`. */
export async function insertPdf(bytes: Uint8Array, other: Uint8Array, at: number) {
  const doc = await PDFDocument.load(bytes);
  const src = await PDFDocument.load(other);
  const copies = await doc.copyPages(src, src.getPageIndices());
  copies.forEach((p, k) => doc.insertPage(at + k, p));
  return doc.save();
}

export async function mergePdfs(files: Uint8Array[]) {
  if (files.length === 0) throw new Error('Nenhum arquivo para combinar.');
  const out = await PDFDocument.create();
  for (const bytes of files) {
    const src = await PDFDocument.load(bytes);
    const copies = await out.copyPages(src, src.getPageIndices());
    copies.forEach((p) => out.addPage(p));
  }
  return out.save();
}

export async function splitPdf(bytes: Uint8Array, groups: number[][]) {
  return Promise.all(groups.map((g) => extractPages(bytes, g)));
}

/** Divide a cada N páginas. */
export function everyN(pageCount: number, n: number): number[][] {
  const groups: number[][] = [];
  for (let i = 0; i < pageCount; i += n) {
    groups.push(Array.from({ length: Math.min(n, pageCount - i) }, (_, k) => i + k));
  }
  return groups;
}

export async function cropPages(
  bytes: Uint8Array,
  indices: number[],
  margins: { top: number; right: number; bottom: number; left: number },
) {
  const doc = await PDFDocument.load(bytes);
  for (const i of indices) {
    const page = doc.getPage(i);
    const b = page.getCropBox();
    const w = b.width - margins.left - margins.right;
    const h = b.height - margins.top - margins.bottom;
    if (w < 10 || h < 10) throw new Error('As margens de corte são maiores que a página.');
    page.setCropBox(b.x + margins.left, b.y + margins.bottom, w, h);
  }
  return doc.save();
}
