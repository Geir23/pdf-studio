import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  degrees,
} from 'pdf-lib';
import { hexToRgb } from '../lib/color';
import { pageGeom, toPdf } from './coords';
import { FontCache, safeText } from './fonts';
import type { FontFamily } from './types';

// ---------- Marca d'água ----------

export interface WatermarkOptions {
  text: string;
  size: number;
  color: string;
  opacity: number;
  angle: number; // graus, anti-horário como o usuário vê
  font: FontFamily;
  bold: boolean;
  pages: number[];
}

export async function addWatermark(bytes: Uint8Array, opt: WatermarkOptions) {
  const doc = await PDFDocument.load(bytes);
  const font = await new FontCache(doc).get(opt.font, opt.bold);
  const text = safeText(font, opt.text);
  const w = font.widthOfTextAtSize(text, opt.size);
  const h = font.heightAtSize(opt.size, { descender: false });
  const th = (opt.angle * Math.PI) / 180;
  const u = { x: Math.cos(th), y: -Math.sin(th) }; // direção do texto (y para baixo)
  const up = { x: -Math.sin(th), y: -Math.cos(th) };
  for (const i of opt.pages) {
    const page = doc.getPage(i);
    const g = pageGeom(page);
    const cx = g.viewW / 2;
    const cy = g.viewH / 2;
    const sx = cx - (u.x * w) / 2 - (up.x * h) / 2;
    const sy = cy - (u.y * w) / 2 - (up.y * h) / 2;
    const p = toPdf(g, sx, sy);
    page.drawText(text, {
      x: p.x,
      y: p.y,
      size: opt.size,
      font,
      color: hexToRgb(opt.color),
      opacity: opt.opacity,
      rotate: degrees(g.rot + opt.angle),
    });
  }
  return doc.save();
}

// ---------- Cabeçalho, rodapé e numeração ----------

export type Slot = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface HeaderFooterOptions {
  /** Textos por posição. Suporta {n} (página), {total} e {data}. */
  slots: Partial<Record<Slot, string>>;
  size: number;
  color: string;
  font: FontFamily;
  margin: number;
  startAt: number;
  pages: number[];
}

export function fillTemplate(tpl: string, n: number, total: number) {
  return tpl
    .replaceAll('{n}', String(n))
    .replaceAll('{total}', String(total))
    .replaceAll('{data}', new Date().toLocaleDateString('pt-BR'));
}

export async function addHeaderFooter(bytes: Uint8Array, opt: HeaderFooterOptions) {
  const doc = await PDFDocument.load(bytes);
  const font = await new FontCache(doc).get(opt.font);
  const total = opt.pages.length + opt.startAt - 1;
  opt.pages.forEach((pageIndex, k) => {
    const page = doc.getPage(pageIndex);
    const g = pageGeom(page);
    for (const [slot, tpl] of Object.entries(opt.slots) as [Slot, string][]) {
      if (!tpl?.trim()) continue;
      const text = safeText(font, fillTemplate(tpl, opt.startAt + k, total));
      const w = font.widthOfTextAtSize(text, opt.size);
      const [vert, horiz] = slot.split('-');
      const x = horiz === 'left' ? opt.margin : horiz === 'right' ? g.viewW - opt.margin - w : (g.viewW - w) / 2;
      const y = vert === 'top' ? opt.margin + opt.size : g.viewH - opt.margin;
      const p = toPdf(g, x, y);
      page.drawText(text, { x: p.x, y: p.y, size: opt.size, font, color: hexToRgb(opt.color), rotate: degrees(g.rot) });
    }
  });
  return doc.save();
}

// ---------- Propriedades ----------

export interface Metadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
}

export async function getMetadata(bytes: Uint8Array): Promise<Metadata> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return {
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    subject: doc.getSubject() ?? '',
    keywords: doc.getKeywords() ?? '',
    creator: doc.getCreator() ?? '',
    producer: doc.getProducer() ?? '',
  };
}

export async function setMetadata(bytes: Uint8Array, m: Metadata) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.setTitle(m.title, { showInWindowTitleBar: true });
  doc.setAuthor(m.author);
  doc.setSubject(m.subject);
  doc.setKeywords(m.keywords.split(/[,;]/).map((k) => k.trim()).filter(Boolean));
  doc.setCreator(m.creator);
  doc.setProducer(m.producer);
  doc.setModificationDate(new Date());
  return doc.save();
}

// ---------- Otimização sem perdas ----------

export async function optimizeLossless(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.save({ useObjectStreams: true });
}

// ---------- Proteção por senha ----------

export interface ProtectOptions {
  userPassword: string;
  ownerPassword: string;
  allowPrinting: boolean;
  allowCopying: boolean;
  allowModifying: boolean;
  allowAnnotating: boolean;
  allowFillingForms: boolean;
}

export async function encryptPdf(bytes: Uint8Array, opt: ProtectOptions) {
  const doc = await PDFDocument.load(bytes);
  doc.encrypt({
    userPassword: opt.userPassword,
    ownerPassword: opt.ownerPassword || opt.userPassword,
    permissions: {
      printing: opt.allowPrinting ? 'highResolution' : false,
      copying: opt.allowCopying,
      modifying: opt.allowModifying,
      annotating: opt.allowAnnotating,
      fillingForms: opt.allowFillingForms,
      contentAccessibility: true,
      documentAssembly: opt.allowModifying,
    },
  });
  return doc.save();
}

/** Abre um PDF possivelmente protegido e devolve uma cópia sem criptografia. */
export async function decryptPdf(bytes: Uint8Array, password: string) {
  const doc = await PDFDocument.load(bytes, { password });
  // O pdf-lib mantém o antigo dicionário de trailer (stream XRef) como objeto comum,
  // ainda apontando para /Encrypt; outros leitores o tratariam como criptografado.
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    const type = dict.get(PDFName.of('Type'));
    const isXref = type instanceof PDFName && type.asString() === '/XRef';
    const isEncryptDict = dict.has(PDFName.of('Filter')) && dict.has(PDFName.of('O')) && dict.has(PDFName.of('U'));
    if (isXref || isEncryptDict) doc.context.delete(ref);
  }
  return doc.save();
}

export async function isEncrypted(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.isEncrypted;
}

// ---------- Formulários ----------

export type FieldInfo =
  | { name: string; type: 'text'; value: string; multiline: boolean; readOnly: boolean }
  | { name: string; type: 'checkbox'; value: boolean; readOnly: boolean }
  | { name: string; type: 'radio' | 'dropdown'; value: string; options: string[]; readOnly: boolean }
  | { name: string; type: 'list'; value: string[]; options: string[]; readOnly: boolean }
  | { name: string; type: 'other'; readOnly: boolean };

export async function getFormFields(bytes: Uint8Array): Promise<FieldInfo[]> {
  const doc = await PDFDocument.load(bytes);
  return doc
    .getForm()
    .getFields()
    .map((f): FieldInfo => {
      const name = f.getName();
      const readOnly = f.isReadOnly();
      if (f instanceof PDFTextField) {
        return { name, type: 'text', value: f.getText() ?? '', multiline: f.isMultiline(), readOnly };
      }
      if (f instanceof PDFCheckBox) return { name, type: 'checkbox', value: f.isChecked(), readOnly };
      if (f instanceof PDFRadioGroup) {
        return { name, type: 'radio', value: f.getSelected() ?? '', options: f.getOptions(), readOnly };
      }
      if (f instanceof PDFDropdown) {
        return { name, type: 'dropdown', value: f.getSelected()[0] ?? '', options: f.getOptions(), readOnly };
      }
      if (f instanceof PDFOptionList) {
        return { name, type: 'list', value: f.getSelected(), options: f.getOptions(), readOnly };
      }
      return { name, type: 'other', readOnly };
    });
}

export async function fillForm(
  bytes: Uint8Array,
  values: Record<string, string | boolean | string[]>,
  flatten: boolean,
) {
  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();
  for (const [name, value] of Object.entries(values)) {
    const f = form.getFieldMaybe(name);
    if (!f || f.isReadOnly()) continue;
    if (f instanceof PDFTextField) f.setText(String(value));
    else if (f instanceof PDFCheckBox) (value ? f.check() : f.uncheck());
    else if (f instanceof PDFRadioGroup && value) f.select(String(value));
    else if (f instanceof PDFDropdown && value) f.select(String(value));
    else if (f instanceof PDFOptionList && Array.isArray(value)) f.select(value);
  }
  if (flatten) form.flatten();
  return doc.save();
}

export async function flattenForm(bytes: Uint8Array) {
  return fillForm(bytes, {}, true);
}
