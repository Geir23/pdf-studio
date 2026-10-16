import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from 'pdf-lib';

export interface PdfaPreflight {
  /** Fontes usadas sem o arquivo embutido (impedem a conformidade). */
  missingFonts: string[];
  /** Formulário interativo presente (os campos usam fontes não embutidas). */
  hasForm: boolean;
}

function fontName(font: PDFDict): string {
  const n = font.lookup(PDFName.of('BaseFont'));
  return n instanceof PDFName ? n.decodeText() : 'sem nome';
}

function isEmbedded(font: PDFDict): boolean {
  const subtype = (font.lookup(PDFName.of('Subtype')) as PDFName | undefined)?.asString();
  if (subtype === '/Type3') return true; // glifos definidos no próprio PDF
  const target = subtype === '/Type0' ? font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookup(0, PDFDict) : font;
  const fd = target?.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  return !!fd && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
}

/** Percorre as fontes de todas as páginas (inclusive dentro de XObjects de formulário). */
export async function preflightPdfa(bytes: Uint8Array): Promise<PdfaPreflight> {
  const doc = await PDFDocument.load(bytes);
  const missing = new Set<string>();
  const seen = new Set<PDFDict>();
  const visit = (res: PDFDict | undefined, depth: number) => {
    if (!res || seen.has(res) || depth > 8) return;
    seen.add(res);
    const fonts = res.lookupMaybe(PDFName.of('Font'), PDFDict);
    for (const [, ref] of fonts?.entries() ?? []) {
      const font = doc.context.lookup(ref);
      if (font instanceof PDFDict && !isEmbedded(font)) missing.add(fontName(font));
    }
    const xobjs = res.lookupMaybe(PDFName.of('XObject'), PDFDict);
    for (const [, ref] of xobjs?.entries() ?? []) {
      const x = doc.context.lookup(ref as PDFRef);
      const dict = x instanceof PDFStream ? x.dict : null;
      if (dict && (dict.lookup(PDFName.of('Subtype')) as PDFName | undefined)?.asString() === '/Form') {
        visit(dict.lookupMaybe(PDFName.of('Resources'), PDFDict), depth + 1);
      }
    }
  };
  for (const page of doc.getPages()) visit(page.node.Resources(), 0);
  return { missingFonts: [...missing].sort(), hasForm: doc.getForm().getFields().length > 0 };
}

/**
 * Converte para PDF/A-2b: perfil de cor sRGB (OutputIntent), metadados XMP com a
 * identificação PDF/A, /ID do documento e versão do cabeçalho.
 */
export async function convertToPdfa(bytes: Uint8Array, title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  if (!doc.getTitle()) doc.setTitle(title);
  doc.convertToPDFA({ conformance: '2B' });
  return doc.save();
}
