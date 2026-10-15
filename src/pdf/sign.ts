import forge from 'node-forge';
import { PDFDocument, degrees } from 'pdf-lib';
import { P12Signer } from '@signpdf/signer-p12';
import { SignPdf } from '@signpdf/signpdf';
import { Buffer } from 'buffer';
import { dataUrlMime, dataUrlToBytes } from '../lib/bytes';
import { hexToRgb } from '../lib/color';
import { pageGeom, placeBox, toPdf } from './coords';
import { FontCache, safeText } from './fonts';
import { addSignaturePlaceholder, nextSignatureFieldName } from './signPlaceholder';
import type { Box } from './types';

export interface CertInfo {
  commonName: string;
  email: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  selfSigned: boolean;
}

function toBinary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
}

/** Lê o certificado de um arquivo .p12/.pfx. Lança erro se a senha estiver errada. */
export function readCertificate(p12: Uint8Array, passphrase: string): CertInfo {
  let parsed: forge.pkcs12.Pkcs12Pfx;
  try {
    parsed = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(toBinary(p12)), passphrase);
  } catch {
    throw new Error('Não foi possível abrir o certificado. Verifique o arquivo e a senha.');
  }
  const bags = parsed.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const keyBags = parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
  if (!keyBags.length) throw new Error('O certificado não contém a chave privada necessária para assinar.');
  // O certificado do titular é o que não é emissor de nenhum outro da cadeia.
  const certs = bags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  if (!certs.length) throw new Error('Nenhum certificado encontrado no arquivo.');
  const issuers = new Set(certs.map((c) => c.issuer.hash));
  const cert = certs.find((c) => !issuers.has(c.subject.hash) || certs.length === 1) ?? certs[0];
  const attr = (name: string, from: forge.pki.Certificate['subject']) =>
    (from.getField(name)?.value as string | undefined) ?? '';
  return {
    commonName: attr('CN', cert.subject) || 'Desconhecido',
    email: attr('E', cert.subject),
    issuer: attr('CN', cert.issuer) || attr('O', cert.issuer),
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
    selfSigned: cert.subject.hash === cert.issuer.hash,
  };
}

export interface DigitalSignOptions {
  p12: Uint8Array;
  passphrase: string;
  page: number;
  /** Área visível da assinatura (espaço de visualização). null = assinatura invisível. */
  box: Box | null;
  reason: string;
  location: string;
  contact: string;
  /** Imagem da assinatura manuscrita para compor a aparência (opcional). */
  imageDataUrl: string | null;
}

export async function signDigitally(bytes: Uint8Array, opt: DigitalSignOptions): Promise<Uint8Array> {
  const info = readCertificate(opt.p12, opt.passphrase);
  const now = new Date();
  // Salvamento incremental: o arquivo original fica intacto e as assinaturas anteriores
  // continuam válidas.
  const doc = await PDFDocument.load(bytes, { forIncrementalUpdate: true });
  const page = doc.getPage(opt.page);
  const g = pageGeom(page);

  let widgetRect = [0, 0, 0, 0];
  if (opt.box) {
    const { x, y, w, h } = opt.box;
    const a = toPdf(g, x, y);
    const b = toPdf(g, x + w, y + h);
    widgetRect = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
    await drawAppearance(doc, page, opt.box, info, opt, now);
  }

  addSignaturePlaceholder({
    doc,
    page,
    reason: opt.reason || 'Assinatura do documento',
    contactInfo: opt.contact || info.email,
    name: info.commonName,
    location: opt.location,
    signingTime: now,
    signatureLength: 16384,
    widgetRect,
    appName: 'PDF Studio',
    fieldName: nextSignatureFieldName(doc),
  });
  const prepared = await doc.save({ useObjectStreams: false });
  const signer = new P12Signer(Buffer.from(opt.p12), { passphrase: opt.passphrase });
  // Classe nomeada: o export default do pacote (CommonJS) muda de forma no bundle do navegador.
  const signed = await new SignPdf().sign(Buffer.from(prepared), signer, now);
  return new Uint8Array(signed);
}

async function drawAppearance(
  doc: PDFDocument,
  page: ReturnType<PDFDocument['getPage']>,
  box: Box,
  info: CertInfo,
  opt: DigitalSignOptions,
  when: Date,
) {
  const g = pageGeom(page);
  const rotate = degrees(g.rot);
  const font = await new FontCache(doc).get('Helvetica');
  const bold = await new FontCache(doc).get('Helvetica', true);
  const a = placeBox(g, box.x, box.y, box.h);
  page.drawRectangle({
    x: a.x, y: a.y, width: box.w, height: box.h, rotate,
    borderColor: hexToRgb('#1f4e9c'), borderWidth: 0.8, color: hexToRgb('#f3f7fd'),
  });
  let textX = box.x + 6;
  if (opt.imageDataUrl) {
    const raw = dataUrlToBytes(opt.imageDataUrl);
    const img = dataUrlMime(opt.imageDataUrl) === 'image/jpeg' ? await doc.embedJpg(raw) : await doc.embedPng(raw);
    const maxW = box.w * 0.45;
    const maxH = box.h - 8;
    const s = Math.min(maxW / img.width, maxH / img.height);
    const iw = img.width * s;
    const ih = img.height * s;
    const ia = placeBox(g, box.x + 4, box.y + (box.h - ih) / 2, ih);
    page.drawImage(img, { x: ia.x, y: ia.y, width: iw, height: ih, rotate });
    textX = box.x + 8 + iw;
  }
  const lines: [string, boolean][] = [
    ['Assinado digitalmente por', false],
    [info.commonName, true],
    [`Data: ${when.toLocaleString('pt-BR')}`, false],
  ];
  if (opt.reason) lines.push([`Motivo: ${opt.reason}`, false]);
  if (opt.location) lines.push([`Local: ${opt.location}`, false]);
  const available = box.x + box.w - textX - 4;
  const size = Math.max(4, Math.min(9, (box.h - 6) / (lines.length * 1.25)));
  lines.forEach(([text, isBold], i) => {
    const f = isBold ? bold : font;
    let t = safeText(f, text);
    while (t.length > 3 && f.widthOfTextAtSize(t, size) > available) t = t.slice(0, -2) + '…';
    const p = toPdf(g, textX, box.y + 4 + size * (i * 1.25 + 1));
    page.drawText(safeText(f, t), { x: p.x, y: p.y, size, font: f, color: hexToRgb('#1f2a44'), rotate });
  });
}

/** Gera um certificado autoassinado (.p12) para testes. Não tem validade jurídica. */
export async function generateTestCertificate(name: string, email: string, passphrase: string): Promise<Uint8Array> {
  const keys = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) =>
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, kp) => (err ? reject(err) : resolve(kp))),
  );
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 3);
  const attrs = [{ name: 'commonName', value: name }];
  if (email) attrs.push({ name: 'emailAddress', value: email });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: '3des' });
  const der = forge.asn1.toDer(asn1).getBytes();
  const out = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) out[i] = der.charCodeAt(i);
  return out;
}
