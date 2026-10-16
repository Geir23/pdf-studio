// Entradas além do PDF: imagens, Word (.docx), HTML, Markdown e texto.
import { marked, type Token, type Tokens } from 'marked';
import { PDFDocument } from 'pdf-lib';
import type { Block, Inline } from './types';

export type InputKind = 'pdf' | 'image' | 'docx' | 'html' | 'markdown' | 'text';

export function detectKind(name: string, mime = ''): InputKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'].includes(ext) || mime.startsWith('image/')) return 'image';
  if (ext === 'docx') return 'docx';
  if (ext === 'html' || ext === 'htm' || mime === 'text/html') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt' || mime === 'text/plain') return 'text';
  return null;
}

export const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,.docx,.html,.htm,.md,.markdown,.txt';

/** Coloca imagens (PNG/JPEG) em páginas de um PDF, uma por página, para passar pelo OCR. */
export async function imagesToPdfBytes(images: { bytes: Uint8Array; type: 'png' | 'jpg' }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const im of images) {
    const img = im.type === 'png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
    // 96 dpi → pontos; imagens grandes (fotos de celular) são reduzidas para caber em ~A4.
    let w = img.width * 0.75;
    let h = img.height * 0.75;
    const s = Math.min(1, 842 / Math.max(w, h));
    w *= s;
    h *= s;
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return doc.save();
}

export async function htmlToMarkdown(html: string): Promise<string> {
  const { default: TurndownService } = await import('turndown');
  const { gfm } = await import('turndown-plugin-gfm');
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
  td.use(gfm);
  td.remove(['script', 'style']);
  // Tabelas sem <thead> (comum no Word): a primeira linha vira o cabeçalho.
  td.addRule('tabela', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = Array.from((node as HTMLTableElement).querySelectorAll('tr'));
      const grid = rows.map((r) =>
        Array.from(r.querySelectorAll('th, td')).map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')),
      );
      if (!grid.length) return '';
      const width = Math.max(...grid.map((r) => r.length));
      const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
      return `\n\n${[line(grid[0]), line(Array(width).fill('---')), ...grid.slice(1).map(line)].join('\n')}\n\n`;
    },
  });
  return td.turndown(html).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export async function docxToMarkdown(bytes: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth');
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  // Navegador lê arrayBuffer; Node, buffer.
  const B = (globalThis as { Buffer?: { from(b: ArrayBuffer): unknown } }).Buffer;
  const { value } = await mammoth.convertToHtml({ arrayBuffer: buf, ...(B ? { buffer: B.from(buf) } : {}) } as never);
  return htmlToMarkdown(value);
}

function dataUrlBytes(url: string): Uint8Array | undefined {
  const m = url.match(/^data:image\/png;base64,(.+)$/);
  if (!m) return undefined;
  const bin = atob(m[1]);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function inlineTokens(tokens: Token[] | undefined, fmt: Omit<Inline, 'text'> = {}): Inline[] {
  const out: Inline[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong': out.push(...inlineTokens((t as Tokens.Strong).tokens, { ...fmt, bold: true })); break;
      case 'em': out.push(...inlineTokens((t as Tokens.Em).tokens, { ...fmt, italic: true })); break;
      case 'link': out.push(...inlineTokens((t as Tokens.Link).tokens, { ...fmt, link: (t as Tokens.Link).href })); break;
      case 'codespan': out.push({ ...fmt, text: (t as Tokens.Codespan).text }); break;
      case 'br': out.push({ ...fmt, text: ' ' }); break;
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...inlineTokens(tt.tokens, fmt));
        else out.push({ ...fmt, text: decode(tt.text) });
        break;
      }
      case 'escape': out.push({ ...fmt, text: (t as Tokens.Escape).text }); break;
      case 'image': break;
      default:
        if ('text' in t && typeof t.text === 'string') out.push({ ...fmt, text: decode(t.text) });
    }
  }
  return out;
}

function decode(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Markdown → blocos (permite gerar Word/HTML/JSON a partir de .docx, .html, .md e .txt). */
export function markdownToBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let imageCount = 0;
  const walk = (tokens: Token[]) => {
    for (const t of tokens) {
      if (t.type === 'heading') {
        const h = t as Tokens.Heading;
        // Título já é destacado: o negrito do Word dentro dele é redundante.
        blocks.push({ type: 'heading', level: h.depth, content: inlineTokens(h.tokens).map(({ bold: _b, ...c }) => c), page: 0 });
      } else if (t.type === 'paragraph') {
        const p = t as Tokens.Paragraph;
        for (const im of p.tokens.filter((x) => x.type === 'image') as Tokens.Image[]) {
          imageCount++;
          blocks.push({ type: 'image', name: `imagem${imageCount}.png`, alt: im.text || `Imagem ${imageCount}`, page: 0,
            rect: { x: 0, y: 0, w: 400, h: 300 }, png: dataUrlBytes(im.href) });
        }
        const content = inlineTokens(p.tokens);
        if (content.some((c) => c.text.trim())) blocks.push({ type: 'paragraph', content, page: 0 });
      } else if (t.type === 'list') {
        const l = t as Tokens.List;
        blocks.push({ type: 'list', ordered: l.ordered, items: l.items.map((it) => inlineTokens(it.tokens.flatMap((x) => ('tokens' in x && x.tokens ? x.tokens : [x])))), page: 0 });
      } else if (t.type === 'table') {
        const tb = t as Tokens.Table;
        const cell = (c: Tokens.TableCell) => inlineTokens(c.tokens).map((i) => i.text).join('');
        blocks.push({ type: 'table', rows: [tb.header.map(cell), ...tb.rows.map((r) => r.map(cell))], page: 0 });
      } else if (t.type === 'blockquote') {
        walk((t as Tokens.Blockquote).tokens);
      } else if (t.type === 'code') {
        blocks.push({ type: 'paragraph', content: [{ text: (t as Tokens.Code).text }], page: 0 });
      }
    }
  };
  walk(marked.lexer(md));
  return blocks;
}

/** Texto simples → blocos (parágrafos separados por linha em branco). */
export function textToBlocks(text: string): Block[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .map((p) => ({ type: 'paragraph' as const, content: [{ text: p }], page: 0 }));
}
