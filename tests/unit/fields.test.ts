import { PDFArray, PDFDict, PDFDocument, PDFName, PDFSignature, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { flattenObjects } from '../../src/pdf/flatten';
import { fillForm, getFormFields } from '../../src/pdf/tools';
import type { FieldObject, LinkObject } from '../../src/pdf/types';
import { pagesText, samplePdf } from './helpers';

const field = (p: Partial<FieldObject>): FieldObject => ({
  id: Math.random().toString(36), page: 0, kind: 'field', x: 50, y: 100, w: 180, h: 22,
  fieldType: 'text', name: 'campo', options: [], value: '', fontSize: 11, required: false, ...p,
});

describe('criar campos de formulário', () => {
  for (const rotation of [0, 90]) {
    it(`todos os tipos (página com rotação ${rotation})`, async () => {
      const out = await flattenObjects(await samplePdf(1, rotation), [
        field({ name: 'nome', required: true }),
        field({ name: 'obs', fieldType: 'multiline', y: 140, h: 60 }),
        field({ name: 'aceito', fieldType: 'checkbox', y: 220, w: 14, h: 14 }),
        field({ name: 'estado', fieldType: 'dropdown', y: 250, options: ['SP', 'RJ', 'MG'], value: 'RJ' }),
        field({ name: 'plano', fieldType: 'radio', y: 290, w: 14, h: 14, options: ['basico'] }),
        field({ name: 'plano', fieldType: 'radio', y: 310, w: 14, h: 14, options: ['premium'] }),
        field({ name: 'assinatura', fieldType: 'signature', y: 350, h: 50 }),
      ]);
      const fields = await getFormFields(out);
      expect(fields.map((f) => [f.name, f.type])).toEqual([
        ['nome', 'text'], ['obs', 'text'], ['aceito', 'checkbox'], ['estado', 'dropdown'], ['plano', 'radio'], ['assinatura', 'other'],
      ]);
      expect(fields[3]).toMatchObject({ value: 'RJ', options: ['SP', 'RJ', 'MG'] });
      expect(fields[4]).toMatchObject({ options: ['basico', 'premium'] });
      const doc = await PDFDocument.load(out);
      expect(doc.getForm().getFields().some((f) => f instanceof PDFSignature)).toBe(true);
      expect(doc.getForm().getTextField('nome').isRequired()).toBe(true);

      // O campo criado pode ser preenchido depois, como qualquer formulário.
      const filled = await fillForm(out, { nome: 'Ana Souza', plano: 'premium', aceito: true }, true);
      expect(pagesText(filled)[0]).toContain('Ana Souza');
    });
  }

  it('nomes repetidos ganham sufixo', async () => {
    const out = await flattenObjects(await samplePdf(1), [field({ name: 'x' }), field({ name: 'x', y: 200 })]);
    expect((await getFormFields(out)).map((f) => f.name)).toEqual(['x', 'x_2']);
  });
});

describe('links', () => {
  it('cria link para site e para página', async () => {
    const link = (p: Partial<LinkObject>): LinkObject => ({ id: 'l', page: 0, kind: 'link', x: 50, y: 50, w: 100, h: 20, url: '', targetPage: 0, ...p });
    const out = await flattenObjects(await samplePdf(3), [link({ url: 'exemplo.com.br' }), link({ y: 100, targetPage: 2 })]);
    const doc = await PDFDocument.load(out);
    const annots = doc.getPage(0).node.Annots()!.asArray().map((r) => doc.context.lookup(r) as PDFDict);
    const actions = annots.map((a) => a.lookup(PDFName.of('A'), PDFDict));
    expect((actions[0].lookup(PDFName.of('URI')) as PDFString).decodeText()).toBe('https://exemplo.com.br');
    const dest = actions[1].lookup(PDFName.of('D'), PDFArray);
    expect(dest.get(0)).toBe(doc.getPage(2).ref);
  });
});
