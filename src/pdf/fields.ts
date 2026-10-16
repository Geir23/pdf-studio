import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFPage, PDFRadioGroup, PDFString, degrees, rgb } from 'pdf-lib';
import { pageGeom, placeBox, toPdf, type PageGeom } from './coords';
import type { Box, FieldObject, LinkObject } from './types';

function pdfRect(g: PageGeom, b: Box): [number, number, number, number] {
  const a = toPdf(g, b.x, b.y);
  const c = toPdf(g, b.x + b.w, b.y + b.h);
  return [Math.min(a.x, c.x), Math.min(a.y, c.y), Math.max(a.x, c.x), Math.max(a.y, c.y)];
}

function uniqueName(doc: PDFDocument, wanted: string): string {
  const taken = new Set(doc.getForm().getFields().map((f) => f.getName()));
  const base = (wanted.trim() || 'campo').replace(/\./g, '_');
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** Cria um campo de formulário interativo (AcroForm) na página. */
export function addFormField(doc: PDFDocument, page: PDFPage, o: FieldObject) {
  const g = pageGeom(page);
  const form = doc.getForm();
  // A caixa visual (w × h) vira, no referencial do campo, largura × altura já girados com a página.
  const a = placeBox(g, o.x, o.y, o.h);
  const appearance = {
    x: a.x, y: a.y, width: o.w, height: o.h, rotate: degrees(g.rot),
    borderColor: rgb(0.45, 0.5, 0.6), borderWidth: 1, backgroundColor: rgb(0.95, 0.97, 1),
  };
  switch (o.fieldType) {
    case 'text':
    case 'multiline': {
      const f = form.createTextField(uniqueName(doc, o.name));
      if (o.fieldType === 'multiline') f.enableMultiline();
      if (o.value) f.setText(o.value);
      f.addToPage(page, appearance);
      f.setFontSize(o.fontSize);
      if (o.required) f.enableRequired();
      return;
    }
    case 'checkbox': {
      const f = form.createCheckBox(uniqueName(doc, o.name));
      f.addToPage(page, appearance);
      if (o.value === 'true') f.check();
      if (o.required) f.enableRequired();
      return;
    }
    case 'dropdown': {
      const f = form.createDropdown(uniqueName(doc, o.name));
      const opts = o.options.map((x) => x.trim()).filter(Boolean);
      if (opts.length) f.addOptions(opts);
      if (o.value && opts.includes(o.value)) f.select(o.value);
      f.addToPage(page, appearance);
      f.setFontSize(o.fontSize);
      if (o.required) f.enableRequired();
      return;
    }
    case 'radio': {
      // Botões com o mesmo nome formam um grupo; cada um tem seu valor.
      const name = (o.name.trim() || 'opcoes').replace(/\./g, '_');
      const existing = form.getFieldMaybe(name);
      const group = existing instanceof PDFRadioGroup ? existing : form.createRadioGroup(uniqueName(doc, name));
      const value = (o.options[0] || `opcao${group.getOptions().length + 1}`).trim();
      group.addOptionToPage(value, page, appearance);
      if (o.value === 'true') group.select(value);
      if (o.required) group.enableRequired();
      return;
    }
    case 'signature':
      return addEmptySignatureField(doc, page, uniqueName(doc, o.name), pdfRect(g, o));
  }
}

/** Campo de assinatura vazio, para ser assinado depois (aqui ou em outro leitor). */
function addEmptySignatureField(doc: PDFDocument, page: PDFPage, name: string, rect: number[]) {
  const widget = doc.context.register(
    doc.context.obj({
      Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: rect, T: PDFHexString.fromText(name), F: 4, P: page.ref,
      MK: { BC: [0.45, 0.5, 0.6], BG: [0.95, 0.97, 1] },
    }),
  );
  page.node.addAnnot(widget);
  let acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acroForm) {
    acroForm = doc.context.obj({ Fields: [] });
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acroForm));
  }
  let fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) {
    fields = doc.context.obj([]);
    acroForm.set(PDFName.of('Fields'), fields);
  }
  fields.push(widget);
}

/** Cria uma anotação de link (URL externa ou página do documento). */
export function addLink(doc: PDFDocument, page: PDFPage, o: LinkObject) {
  const g = pageGeom(page);
  const action = o.url.trim()
    ? doc.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(normalizeUrl(o.url)) })
    : doc.context.obj({ Type: 'Action', S: 'GoTo', D: [doc.getPage(o.targetPage).ref, 'Fit'] });
  const annot = doc.context.register(
    doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: pdfRect(g, o), Border: [0, 0, 0], F: 4, A: action }),
  );
  page.node.addAnnot(annot);
}

export function normalizeUrl(url: string): string {
  const u = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u)) return `mailto:${u}`;
  return `https://${u}`;
}
