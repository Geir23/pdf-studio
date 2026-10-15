import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export async function samplePdf(pages = 3, rotation = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Pagina ${i}`, { x: 50, y: 780, size: 24, font });
    if (rotation) page.setRotation({ type: 'degrees', angle: rotation } as never);
  }
  return doc.save();
}

const dir = mkdtempSync(join(tmpdir(), 'pdfstudio-'));
let counter = 0;

export function writeTmp(bytes: Uint8Array, name = 'f.pdf'): string {
  const p = join(dir, `${counter++}-${name}`);
  writeFileSync(p, bytes);
  return p;
}

/** Texto de cada página, extraído pelo poppler (independente das libs do app). */
export function pagesText(bytes: Uint8Array, password?: string): string[] {
  const args = ['-layout'];
  if (password) args.push('-upw', password);
  const out = execFileSync('pdftotext', [...args, writeTmp(bytes), '-'], { encoding: 'utf8' });
  return out.split('\f').slice(0, -1).map((s) => s.trim());
}
