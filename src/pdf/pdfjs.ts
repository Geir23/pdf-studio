// Build "legacy": compatível com navegadores que ainda não têm os recursos de
// JavaScript mais recentes usados pela build padrão do pdf.js.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** URL absoluta de um recurso em public/ (o worker não resolve caminhos relativos). */
export function assetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

export class PasswordRequiredError extends Error {
  constructor(public incorrect: boolean) {
    super(incorrect ? 'Senha incorreta.' : 'Este PDF é protegido por senha.');
  }
}

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const base = assetUrl('vendor/pdfjs/');
  const task = pdfjs.getDocument({
    data: bytes.slice(), // o pdf.js transfere (e invalida) o buffer recebido
    password,
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    wasmUrl: base + 'wasm/',
    iccUrl: base + 'iccs/',
    enableXfa: false,
    fontExtraProperties: true, // nome da fonte (negrito/itálico) para o Conversor
  });
  try {
    return await task.promise;
  } catch (e) {
    if (e instanceof pdfjs.PasswordException) {
      throw new PasswordRequiredError(e.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    }
    throw e;
  }
}

export { pdfjs };
export type { PDFDocumentProxy };
