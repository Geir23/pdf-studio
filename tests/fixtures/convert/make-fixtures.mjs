// Gera os PDFs usados nos testes do Conversor. Requer LibreOffice (soffice) e poppler (pdftoppm).
// Uso: node tests/fixtures/convert/make-fixtures.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AlignmentType, Document, ExternalHyperlink, Footer, Header, HeadingLevel, ImageRun, LevelFormat, Packer,
  PageBreak, PageNumber, Paragraph, SectionType, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

const DIR = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'conv-'));

const LOREM = [
  'A análise considerou os dados coletados entre janeiro e setembro, comparando o desempenho das equipes regionais com as metas definidas no planejamento estratégico.',
  'Os resultados indicam crescimento consistente nas regiões Sul e Sudeste, enquanto o Nordeste apresentou estabilidade, com pequenas variações sazonais ao longo do período.',
  'Recomenda-se ampliar o acompanhamento mensal dos indicadores e revisar os processos de atendimento, priorizando os canais digitais que concentram a maior parte das solicitações.',
  'Por fim, a equipe técnica sugere a criação de um painel integrado, reunindo informações financeiras e operacionais, para apoiar decisões rápidas e bem fundamentadas.',
];

const header = new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Empresa Exemplo Ltda — Documento interno', size: 16, color: '666666' })] })] });
const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Página ', PageNumber.CURRENT], size: 16 })] })] });

const cell = (text, bold = false) => new TableCell({ width: { size: 3000, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });

const doc = new Document({
  numbering: {
    config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: 'numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ],
  },
  styles: { default: { document: { run: { font: 'Liberation Sans', size: 22 } } } },
  sections: [
    {
      headers: { default: header },
      footers: { default: footer },
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Relatório Técnico de Avaliação', size: 40, bold: true })] }),
        new Paragraph({
          children: [
            new TextRun('Este documento apresenta a '),
            new TextRun({ text: 'avaliação completa', bold: true }),
            new TextRun(' do sistema de '),
            new TextRun({ text: 'gestão integrada', italics: true }),
            new TextRun(', com base nos indicadores de desempenho acompanhados ao longo do ano e nas entrevistas realizadas com as equipes envolvidas.'),
          ],
        }),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: 'Objetivos', size: 30, bold: true })] }),
        ...['Medir a satisfação dos usuários', 'Identificar gargalos operacionais', 'Propor melhorias priorizadas'].map(
          (t) => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun(t)] }),
        ),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: 'Etapas', size: 30, bold: true })] }),
        ...['Coleta de dados nas unidades', 'Consolidação e análise estatística'].map(
          (t) => new Paragraph({ numbering: { reference: 'numbers', level: 0 }, children: [new TextRun(t)] }),
        ),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: 'Resultados por região', size: 30, bold: true })] }),
        new Table({
          rows: [
            new TableRow({ children: [cell('Região', true), cell('Atendimentos', true), cell('Satisfação', true)] }),
            new TableRow({ children: [cell('Sul'), cell('1.250'), cell('92%')] }),
            new TableRow({ children: [cell('Sudeste'), cell('3.480'), cell('88%')] }),
            new TableRow({ children: [cell('Nordeste'), cell('2.105'), cell('85%')] }),
          ],
        }),
        new Paragraph({ children: [] }),
        new Paragraph({
          children: [
            new TextRun('Mais detalhes estão disponíveis no '),
            new ExternalHyperlink({ link: 'https://exemplo.gov.br/relatorio', children: [new TextRun({ text: 'portal oficial', style: 'Hyperlink' })] }),
            new TextRun('.'),
          ],
        }),
        new Paragraph({
          children: [new ImageRun({ type: 'png', data: readFileSync(join(DIR, 'grafico.png')), transformation: { width: 450, height: 110 } })],
        }),
        new Paragraph({ children: [new PageBreak()] }),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: 'Análise detalhada', size: 30, bold: true })] }),
      ],
    },
    {
      properties: { type: SectionType.CONTINUOUS, column: { count: 2, space: 708 } },
      headers: { default: header },
      footers: { default: footer },
      children: [...LOREM, ...LOREM, ...LOREM].map((t, i) => `Bloco ${i + 1}: ${t}`).map((t) => new Paragraph({ spacing: { after: 160 }, children: [new TextRun(t)] })),
    },
  ],
});

const docxPath = join(tmp, 'relatorio.docx');
writeFileSync(docxPath, await Packer.toBuffer(doc));
writeFileSync(join(DIR, 'relatorio.docx'), readFileSync(docxPath));
execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', tmp, docxPath], { timeout: 180_000 });
const pdf = readFileSync(join(tmp, 'relatorio.pdf'));
writeFileSync(join(DIR, 'relatorio.pdf'), pdf);

// Versão "escaneada": cada página vira imagem (sem texto selecionável).
execFileSync('pdftoppm', ['-r', '200', '-png', join(DIR, 'relatorio.pdf'), join(tmp, 'pg')]);
const scan = await PDFDocument.create();
for (const n of [1, 2]) {
  const img = await scan.embedPng(readFileSync(join(tmp, `pg-${n}.png`)));
  scan.addPage([595.3, 841.9]).drawImage(img, { x: 0, y: 0, width: 595.3, height: 841.9 });
}
writeFileSync(join(DIR, 'relatorio-escaneado.pdf'), await scan.save());

// Versão com texto "que não dá para copiar": o mapa ToUnicode aponta para caracteres de
// uso privado, como em muitos PDFs reais (a página aparece certa, mas o texto copiado é lixo).
const broken = await PDFDocument.load(pdf);
let touched = 0;
for (const [ref, obj] of broken.context.enumerateIndirectObjects()) {
  if (!(obj instanceof PDFRawStream)) continue;
  let text;
  try {
    text = Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
  } catch {
    continue;
  }
  if (!text.includes('begincmap') || !/beginbf(char|range)/.test(text)) continue;
  const mangled = text.replace(/(<[0-9A-Fa-f]{2,4}>\s*)<([0-9A-Fa-f]{4})>/g,
    (_, src, dst) => `${src}<${(0xe000 + (parseInt(dst, 16) % 0x1000)).toString(16).toUpperCase()}>`);
  broken.context.assign(ref, broken.context.flateStream(Buffer.from(mangled, 'latin1')));
  touched++;
}
if (!touched) console.warn('Aviso: nenhum ToUnicode encontrado para corromper.');
writeFileSync(join(DIR, 'relatorio-texto-ilegivel.pdf'), await broken.save());
console.log('Fixtures geradas em', DIR, `(ToUnicode alterados: ${touched})`);
