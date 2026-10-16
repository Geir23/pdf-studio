// Copia para public/ os arquivos que o pdf.js e o Tesseract carregam em tempo de execução,
// para o app funcionar offline, sem depender de CDN.
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'vendor');

rmSync(out, { recursive: true, force: true });

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  copy(join(nm, 'pdfjs-dist', dir), join(out, 'pdfjs', dir));
}
copy(join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(out, 'tesseract', 'worker.min.js'));
// Só as variantes LSTM (o app usa OEM.LSTM_ONLY); o worker escolhe conforme o suporte a SIMD.
for (const variant of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
  const name = `tesseract-core-${variant}.wasm.js`;
  copy(join(nm, 'tesseract.js-core', name), join(out, 'tesseract', 'core', name));
}
for (const lang of ['por', 'eng']) {
  const src = join(nm, '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`);
  if (!existsSync(src)) throw new Error(`Modelo de OCR ausente: ${src}`);
  copy(src, join(out, 'tessdata', `${lang}.traineddata.gz`));
}
// Fontes Liberation (SIL OFL) embutidas no texto adicionado aos PDFs.
copy(join(root, 'assets', 'fonts'), join(out, 'fonts'));
console.log('Recursos copiados para public/vendor');
