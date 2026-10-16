// Formatos de saída do Conversor, todos gerados a partir dos mesmos blocos.
import JSZip from 'jszip';
import { marked } from 'marked';
import { blocksToMarkdown, blocksToText } from './markdown';
import type { Block, ConvertedDocument, Inline } from './types';

export type OutputFormat = 'md' | 'md-zip' | 'html' | 'docx' | 'txt' | 'json';

export const FORMAT_INFO: Record<OutputFormat, { label: string; ext: string; mime: string }> = {
  md: { label: 'Markdown (.md)', ext: 'md', mime: 'text/markdown;charset=utf-8' },
  'md-zip': { label: 'Markdown + imagens (.zip)', ext: 'zip', mime: 'application/zip' },
  html: { label: 'Página HTML (.html)', ext: 'html', mime: 'text/html;charset=utf-8' },
  docx: { label: 'Word (.docx)', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  txt: { label: 'Texto simples (.txt)', ext: 'txt', mime: 'text/plain;charset=utf-8' },
  json: { label: 'JSON estruturado (.json)', ext: 'json', mime: 'application/json' },
};

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Markdown com as imagens embutidas (data:), usado para HTML e pré-visualização. */
function markdownWithInlineImages(blocks: Block[]): string {
  const withData = blocks.map((b) => (b.type === 'image' && b.png ? { ...b, name: `data:image/png;base64,${toBase64(b.png)}` } : b));
  return blocksToMarkdown(withData, { imageDir: '' });
}

export function toHtml(doc: ConvertedDocument): string {
  const body = marked.parse(markdownWithInlineImages(doc.blocks), { async: false, gfm: true }) as string;
  const title = doc.title.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; line-height: 1.6; max-width: 820px; margin: 2rem auto; padding: 0 1rem; color: #1d2330; }
  h1, h2, h3, h4 { line-height: 1.25; margin-top: 1.6em; }
  table { border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid #cfd6e0; padding: 6px 10px; text-align: left; }
  th { background: #f3f5f8; }
  img { max-width: 100%; height: auto; }
  a { color: #1a5fb4; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function toJson(doc: ConvertedDocument): string {
  return JSON.stringify(
    {
      titulo: doc.title,
      paginas: doc.pageCount,
      paginasComOcr: doc.ocrPages.map((p) => ({ pagina: p.page + 1, motivo: p.reason })),
      blocos: doc.blocks.map((b) => {
        const base = { pagina: b.page + 1 };
        const text = (c: Inline[]) => c.map((i) => i.text).join('');
        switch (b.type) {
          case 'heading': return { ...base, tipo: 'titulo', nivel: b.level, texto: text(b.content) };
          case 'paragraph': return { ...base, tipo: 'paragrafo', texto: text(b.content) };
          case 'list': return { ...base, tipo: 'lista', numerada: b.ordered, itens: b.items.map(text) };
          case 'table': return { ...base, tipo: 'tabela', linhas: b.rows };
          case 'image': return { ...base, tipo: 'imagem', arquivo: `imagens/${b.name}`, descricao: b.alt };
        }
      }),
    },
    null,
    2,
  );
}

export async function toMarkdownZip(doc: ConvertedDocument, baseName: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(`${baseName}.md`, blocksToMarkdown(doc.blocks, { imageDir: 'imagens' }));
  for (const b of doc.blocks) if (b.type === 'image' && b.png) zip.file(`imagens/${b.name}`, b.png);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function toDocx(doc: ConvertedDocument): Promise<Uint8Array> {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType,
    ImageRun, LevelFormat, AlignmentType,
  } = await import('docx');
  const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  const runs = (content: Inline[]) =>
    content.map((c) => {
      const run = new TextRun({ text: c.text, bold: c.bold, italics: c.italic, ...(c.link ? { style: 'Hyperlink' } : {}) });
      return c.link ? new ExternalHyperlink({ link: c.link, children: [run] }) : run;
    });
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  for (const b of doc.blocks) {
    if (b.type === 'heading') children.push(new Paragraph({ heading: levels[Math.min(5, b.level - 1)], children: runs(b.content) }));
    else if (b.type === 'paragraph') children.push(new Paragraph({ children: runs(b.content) }));
    else if (b.type === 'list') {
      for (const it of b.items) children.push(new Paragraph({ numbering: { reference: b.ordered ? 'numeros' : 'marcadores', level: 0 }, children: runs(it) }));
    } else if (b.type === 'table') {
      const width = Math.max(...b.rows.map((r) => r.length));
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map((r, i) =>
            new TableRow({
              tableHeader: i === 0,
              children: Array.from({ length: width }, (_, c) =>
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: r[c] ?? '', bold: i === 0 })] })] })),
            })),
        }),
      );
      children.push(new Paragraph({ children: [] }));
    } else if (b.type === 'image' && b.png) {
      const maxW = 560;
      const ratio = b.rect.h / b.rect.w || 0.5;
      const w = Math.min(maxW, b.rect.w * 1.33);
      children.push(new Paragraph({ children: [new ImageRun({ type: 'png', data: b.png, transformation: { width: Math.round(w), height: Math.round(w * ratio) } })] }));
    }
  }
  const list = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: string) => ({
    level: 0, format, text, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } },
  });
  const docx = new Document({
    title: doc.title,
    numbering: {
      config: [
        { reference: 'marcadores', levels: [list(LevelFormat.BULLET, '•')] },
        { reference: 'numeros', levels: [list(LevelFormat.DECIMAL, '%1.')] },
      ],
    },
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(docx));
}

export async function render(doc: ConvertedDocument, format: OutputFormat, baseName: string): Promise<Uint8Array> {
  const enc = (s: string) => new TextEncoder().encode(s);
  switch (format) {
    case 'md': return enc(blocksToMarkdown(doc.blocks, { imageDir: null }));
    case 'md-zip': return toMarkdownZip(doc, baseName);
    case 'html': return enc(toHtml(doc));
    case 'docx': return toDocx(doc);
    case 'txt': return enc(blocksToText(doc.blocks));
    case 'json': return enc(toJson(doc));
  }
}
