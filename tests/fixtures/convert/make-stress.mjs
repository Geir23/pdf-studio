// Gera PDFs grandes para testar desempenho do Conversor (não são versionados).
// Uso: node tests/fixtures/convert/make-stress.mjs <pasta-de-saída> <foto.jpg>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, HeadingLevel, ImageRun, Packer, PageBreak, Paragraph, TextRun } from 'docx';
import { PDFDocument } from 'pdf-lib';

const [out, fotoPath] = process.argv.slice(2);
const foto = readFileSync(fotoPath);
const grafico = readFileSync(new URL('./grafico.png', import.meta.url));
const children = [];
for (let p = 1; p <= 80; p++) {
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: `Capítulo ${p}`, bold: true, size: 36 })] }));
  for (let k = 0; k < 3; k++) {
    children.push(new Paragraph({ children: [new TextRun(`Parágrafo ${k + 1} do capítulo ${p}. ` + 'Os indicadores mostram evolução consistente ao longo do período analisado, com destaque para as regiões atendidas. '.repeat(3))] }));
  }
  children.push(new Paragraph({ children: [new ImageRun({ type: 'jpg', data: foto, transformation: { width: 480, height: 330 } })] }));
  children.push(new Paragraph({ children: [new ImageRun({ type: 'png', data: grafico, transformation: { width: 420, height: 100 } })] }));
  if (p < 80) children.push(new Paragraph({ children: [new PageBreak()] }));
}
const doc = new Document({ sections: [{ children }] });
writeFileSync(join(out, 'grande.docx'), await Packer.toBuffer(doc));
execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', out, join(out, 'grande.docx')], { timeout: 300_000 });

// Escaneado de 30 páginas (repete as páginas do relatório como imagem).
execFileSync('pdftoppm', ['-r', '200', '-png', new URL('./relatorio.pdf', import.meta.url).pathname, join(out, 'pg')]);
const scan = await PDFDocument.create();
const imgs = [await scan.embedPng(readFileSync(join(out, 'pg-1.png'))), await scan.embedPng(readFileSync(join(out, 'pg-2.png')))];
for (let i = 0; i < 30; i++) scan.addPage([595.3, 841.9]).drawImage(imgs[i % 2], { x: 0, y: 0, width: 595.3, height: 841.9 });
writeFileSync(join(out, 'escaneado-30.pdf'), await scan.save());
console.log('ok');
