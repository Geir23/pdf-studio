// Copia para public/ os arquivos que o pdf.js e o Tesseract carregam em tempo de execução,
// para o app funcionar offline, sem depender de CDN.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'vendor');

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  copy(join(nm, 'pdfjs-dist', dir), join(out, 'pdfjs', dir));
}
copy(join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(out, 'tesseract', 'worker.min.js'));
copy(join(nm, 'tesseract.js-core'), join(out, 'tesseract', 'core'));
for (const lang of ['por', 'eng']) {
  const src = join(nm, '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`);
  if (!existsSync(src)) throw new Error(`Modelo de OCR ausente: ${src}`);
  copy(src, join(out, 'tessdata', `${lang}.traineddata.gz`));
}
console.log('Recursos copiados para public/vendor');
