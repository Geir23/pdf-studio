// Adaptado de @signpdf/placeholder-pdf-lib (MIT). Copiado para usar a mesma instância
// do pdf-lib do app: o pacote original carrega a versão CommonJS da biblioteca, e
// misturar as duas gera um PDF corrompido.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFInvalidObject, PDFName, PDFNumber, PDFPage, PDFString } from 'pdf-lib';

export const BYTE_RANGE_PLACEHOLDER = '**********';
const SIGNATURES_EXIST = 1;
const APPEND_ONLY = 2;
const ANNOT_PRINT = 4;

export interface PlaceholderOptions {
  doc: PDFDocument;
  page: PDFPage;
  reason: string;
  contactInfo: string;
  name: string;
  location: string;
  signingTime: Date;
  signatureLength: number;
  widgetRect: number[];
  appName: string;
  fieldName: string;
}

export function addSignaturePlaceholder(o: PlaceholderOptions) {
  const { doc, page } = o;
  const byteRange = PDFArray.withContext(doc.context);
  byteRange.push(PDFNumber.of(0));
  for (let i = 0; i < 3; i++) byteRange.push(PDFName.of(BYTE_RANGE_PLACEHOLDER));

  const signatureDict = doc.context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: byteRange,
    Contents: PDFHexString.of('\0'.repeat(o.signatureLength)),
    Reason: PDFHexString.fromText(o.reason),
    M: PDFString.fromDate(o.signingTime),
    ContactInfo: PDFHexString.fromText(o.contactInfo),
    Name: PDFHexString.fromText(o.name),
    Location: PDFHexString.fromText(o.location),
    Prop_Build: { Filter: { Name: 'Adobe.PPKLite' }, App: { Name: o.appName } },
  });
  // Grava como objeto "bruto" para o pdf-lib não colocá-lo dentro de um object stream.
  const buf = new Uint8Array(signatureDict.sizeInBytes());
  signatureDict.copyBytesInto(buf, 0);
  const signatureRef = doc.context.register(PDFInvalidObject.of(buf));

  const rect = PDFArray.withContext(doc.context);
  o.widgetRect.forEach((c) => rect.push(PDFNumber.of(c)));
  const apStream = doc.context.formXObject([], { BBox: o.widgetRect, Resources: {} });
  const widgetRef = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      Rect: rect,
      V: signatureRef,
      T: PDFHexString.fromText(o.fieldName),
      F: ANNOT_PRINT,
      P: page.ref,
      AP: { N: doc.context.register(apStream) },
    }),
  );

  let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) annots = doc.context.obj([]);
  annots.push(widgetRef);
  page.node.set(PDFName.of('Annots'), annots);

  let acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acroForm) {
    acroForm = doc.context.obj({ Fields: [] });
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acroForm));
  }
  const flags = acroForm.lookupMaybe(PDFName.of('SigFlags'), PDFNumber)?.asNumber() ?? 0;
  acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(flags | SIGNATURES_EXIST | APPEND_ONLY));
  let fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) {
    fields = doc.context.obj([]);
    acroForm.set(PDFName.of('Fields'), fields);
  }
  fields.push(widgetRef);
}

/** Nome de campo ainda não usado (permite várias assinaturas no mesmo documento). */
export function nextSignatureFieldName(doc: PDFDocument): string {
  const names = new Set(doc.getForm().getFields().map((f) => f.getName()));
  let i = 1;
  while (names.has(`Assinatura${i}`)) i++;
  return `Assinatura${i}`;
}
