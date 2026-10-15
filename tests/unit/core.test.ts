import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { flattenObjects } from '../../src/pdf/flatten';
import {
  deletePages, duplicatePages, everyN, extractPages, insertBlankPage, mergePdfs,
  parseGroups, parseRanges, reorderPages, rotatePages, splitPdf,
} from '../../src/pdf/pages';
import { generateTestCertificate, readCertificate, signDigitally } from '../../src/pdf/sign';
import {
  addHeaderFooter, addWatermark, decryptPdf, encryptPdf, fillForm, getFormFields,
  getMetadata, isEncrypted, setMetadata,
} from '../../src/pdf/tools';
import type { EditObject } from '../../src/pdf/types';
import { pagesText, samplePdf, writeTmp } from './helpers';

const pageCount = async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount();

describe('intervalos de páginas', () => {
  it('interpreta listas e intervalos', () => {
    expect(parseRanges('1-3, 5, 7-', 8)).toEqual([0, 1, 2, 4, 6, 7]);
    expect(parseGroups('1-2; 3\n4-5', 5)).toEqual([[0, 1], [2], [3, 4]]);
    expect(everyN(5, 2)).toEqual([[0, 1], [2, 3], [4]]);
  });
  it('rejeita intervalos inválidos', () => {
    expect(() => parseRanges('0-2', 3)).toThrow(/fora/);
    expect(() => parseRanges('abc', 3)).toThrow(/inválido/);
  });
});

describe('operações de páginas', () => {
  it('reordena, exclui, duplica, insere e gira', async () => {
    const pdf = await samplePdf(3);
    expect(pagesText(await reorderPages(pdf, [2, 0, 1]))).toEqual(['Pagina 3', 'Pagina 1', 'Pagina 2']);
    expect(pagesText(await deletePages(pdf, [1]))).toEqual(['Pagina 1', 'Pagina 3']);
    expect(pagesText(await duplicatePages(pdf, [0]))).toEqual(['Pagina 1', 'Pagina 1', 'Pagina 2', 'Pagina 3']);
    expect(await pageCount(await insertBlankPage(pdf, 1))).toBe(4);
    const rotated = await PDFDocument.load(await rotatePages(pdf, [0], 90));
    expect(rotated.getPage(0).getRotation().angle).toBe(90);
    await expect(deletePages(pdf, [0, 1, 2])).rejects.toThrow();
  });
  it('extrai, combina e divide', async () => {
    const pdf = await samplePdf(4);
    expect(pagesText(await extractPages(pdf, [3, 1]))).toEqual(['Pagina 4', 'Pagina 2']);
    expect(await pageCount(await mergePdfs([pdf, pdf]))).toBe(8);
    const parts = await splitPdf(pdf, [[0], [1, 2, 3]]);
    expect(await Promise.all(parts.map(pageCount))).toEqual([1, 3]);
  });
});

describe('edições gravadas no PDF', () => {
  for (const rotation of [0, 90, 180, 270]) {
    it(`texto e caixa de substituição em página com rotação ${rotation}`, async () => {
      const pdf = await samplePdf(1, rotation);
      const objects: EditObject[] = [
        { id: 'a', page: 0, kind: 'text', x: 60, y: 120, w: 300, h: 40, text: 'Olá, edição çãõ', size: 14,
          color: '#000000', font: 'Helvetica', bold: false, italic: false, bg: '#ffffff' },
        { id: 'b', page: 0, kind: 'highlight', x: 50, y: 50, w: 100, h: 20, color: '#ffff00' },
        { id: 'c', page: 0, kind: 'note', x: 10, y: 10, text: 'Comentário', color: '#ffcc00', author: 'Ana' },
        { id: 'd', page: 0, kind: 'ink', points: [[10, 10], [20, 30], [40, 35]], stroke: '#ff0000', width: 2, opacity: 1 },
        { id: 'e', page: 0, kind: 'arrow', x1: 100, y1: 300, x2: 200, y2: 350, stroke: '#0000ff', width: 2, opacity: 1 },
      ];
      const out = await flattenObjects(pdf, objects);
      const text = pagesText(out)[0];
      expect(text).toContain('Olá, edição çãõ');
      const annots = (await PDFDocument.load(out)).getPage(0).node.Annots();
      expect(annots?.size()).toBe(1);
    });
  }
  it('quebra texto longo em várias linhas e troca caracteres sem suporte', async () => {
    const out = await flattenObjects(await samplePdf(1), [
      { id: 'a', page: 0, kind: 'text', x: 50, y: 200, w: 120, h: 80, text: 'uma frase bem comprida que precisa quebrar 漢',
        size: 12, color: '#000000', font: 'Times', bold: true, italic: true, bg: null },
    ]);
    const lines = pagesText(out)[0].split('\n').map((s) => s.trim()).filter((s) => s && s !== 'Pagina 1');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toContain('?');
  });
});

describe('ferramentas de documento', () => {
  it('marca d’água, cabeçalho/rodapé e metadados', async () => {
    const pdf = await samplePdf(2, 90);
    const wm = await addWatermark(pdf, { text: 'CONFIDENCIAL', size: 50, color: '#ff0000', opacity: 0.3,
      angle: 45, font: 'Helvetica', bold: true, pages: [0, 1] });
    expect(pagesText(wm).every((t) => t.replace(/\s/g, '').includes('CONFIDENCIAL'))).toBe(true);
    const hf = await addHeaderFooter(pdf, { slots: { 'bottom-center': 'Página {n} de {total}' }, size: 10,
      color: '#000000', font: 'Helvetica', margin: 30, startAt: 1, pages: [0, 1] });
    expect(pagesText(hf)[1]).toContain('Página 2 de 2');
    const meta = await setMetadata(pdf, { title: 'Contrato', author: 'Ana', subject: 's', keywords: 'a, b',
      creator: 'c', producer: 'p' });
    expect((await getMetadata(meta)).title).toBe('Contrato');
  });

  it('protege e remove senha', async () => {
    const pdf = await samplePdf(1);
    const enc = await encryptPdf(pdf, { userPassword: 'abc', ownerPassword: 'dono', allowPrinting: true,
      allowCopying: false, allowModifying: false, allowAnnotating: true, allowFillingForms: true });
    expect(await isEncrypted(enc)).toBe(true);
    expect(pagesText(enc, 'abc')[0]).toContain('Pagina 1');
    await expect(decryptPdf(enc, 'errada')).rejects.toThrow();
    const dec = await decryptPdf(enc, 'abc');
    expect(await isEncrypted(dec)).toBe(false);
    expect(pagesText(dec)[0]).toContain('Pagina 1');
  });

  it('lê e preenche formulários', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const form = doc.getForm();
    form.createTextField('nome').addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
    form.createCheckBox('aceito').addToPage(page, { x: 50, y: 650, width: 15, height: 15 });
    const dd = form.createDropdown('estado');
    dd.addOptions(['SP', 'RJ']);
    dd.addToPage(page, { x: 50, y: 600, width: 100, height: 20 });
    const pdf = await doc.save();
    const fields = await getFormFields(pdf);
    expect(fields.map((f) => f.type)).toEqual(['text', 'checkbox', 'dropdown']);
    const filled = await fillForm(pdf, { nome: 'João', aceito: true, estado: 'RJ' }, false);
    const after = await getFormFields(filled);
    expect(after).toMatchObject([{ value: 'João' }, { value: true }, { value: 'RJ' }]);
    const flat = await fillForm(pdf, { nome: 'Maria' }, true);
    expect(await getFormFields(flat)).toEqual([]);
    expect(pagesText(flat)[0]).toContain('Maria');
  });
});

describe('assinatura digital', () => {
  it('gera certificado de teste, assina e o poppler valida a integridade', async () => {
    const p12 = await generateTestCertificate('Maria Teste', 'maria@exemplo.com', 'segredo');
    expect(readCertificate(p12, 'segredo').commonName).toBe('Maria Teste');
    expect(() => readCertificate(p12, 'errada')).toThrow(/senha/);
    const signed = await signDigitally(await samplePdf(1), {
      p12, passphrase: 'segredo', page: 0, box: { x: 300, y: 650, w: 220, h: 60 },
      reason: 'Aprovação', location: 'São Paulo', contact: '', imageDataUrl: null,
    });
    const report = execFileSync('pdfsig', [writeTmp(signed)], { encoding: 'utf8' });
    expect(report).toContain('Maria Teste');
    expect(report).toMatch(/Signature Validation: Signature is Valid/);
    expect(pagesText(signed)[0]).toContain('Assinado digitalmente por');
  });
});

describe('reordenação com árvore de páginas aninhada', () => {
  it('preserva atributos herdados', async () => {
    // Documento combinado de outros dois tende a ter nós intermediários; força rotação herdada.
    const a = await samplePdf(2);
    const merged = await mergePdfs([a, await samplePdf(2, 90)]);
    const out = await reorderPages(merged, [3, 2, 1, 0]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([90, 90, 0, 0]);
    expect(pagesText(out)).toEqual(['Pagina 2', 'Pagina 1', 'Pagina 2', 'Pagina 1']);
  });
});
