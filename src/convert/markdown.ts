import type { Block, Inline } from './types';

export interface MarkdownOptions {
  /** Pasta usada nas referências às imagens; null = não incluir imagens. */
  imageDir: string | null;
}

/** Escapa caracteres que o Markdown interpretaria como formatação. */
function esc(s: string): string {
  return s.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function escLineStart(s: string): string {
  return s.replace(/^(#{1,6}\s)/, '\\$1').replace(/^(\d+)([.)]\s)/, '$1\\$2').replace(/^([-+]\s)/, '\\$1').replace(/^(>)/, '\\$1');
}

export function inlineToMarkdown(content: Inline[]): string {
  let out = '';
  for (const c of content) {
    // Espaços nas bordas ficam fora dos marcadores (senão "** texto**" não vira negrito).
    const m = c.text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    let t = esc(m[2]);
    if (t) {
      if (c.bold && c.italic) t = `***${t}***`;
      else if (c.bold) t = `**${t}**`;
      else if (c.italic) t = `*${t}*`;
      if (c.link) {
        // Pontuação final fica fora do link: "[portal](url)." e não "[portal.](url)".
        const tail = t.match(/[.,;:!?]+$/)?.[0] ?? '';
        t = `[${t.slice(0, t.length - tail.length)}](${c.link.replace(/[()\s]/g, encodeURIComponent)})${tail}`;
      }
    }
    out += m[1] + t + m[3];
  }
  // Une marcadores vizinhos iguais: "**a** **b**" → "**a b**".
  return out.replace(/\*\*(\s+)\*\*/g, '$1').trim();
}

function cell(s: string) {
  return esc(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

export function blocksToMarkdown(blocks: Block[], opts: MarkdownOptions): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        parts.push(`${'#'.repeat(Math.min(6, Math.max(1, b.level)))} ${inlineToMarkdown(b.content)}`);
        break;
      case 'paragraph': {
        const t = inlineToMarkdown(b.content);
        if (t) parts.push(escLineStart(t));
        break;
      }
      case 'list':
        parts.push(b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '-'} ${inlineToMarkdown(it)}`).join('\n'));
        break;
      case 'table': {
        const width = Math.max(...b.rows.map((r) => r.length));
        const rows = b.rows.map((r) => [...r, ...Array(width - r.length).fill('')].map(cell));
        const line = (r: string[]) => `| ${r.join(' | ')} |`;
        parts.push([line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n'));
        break;
      }
      case 'image':
        if (opts.imageDir !== null) parts.push(`![${esc(b.alt)}](${opts.imageDir ? `${opts.imageDir}/` : ''}${b.name})`);
        break;
    }
  }
  return parts.join('\n\n') + '\n';
}

export function blocksToText(blocks: Block[]): string {
  const plain = (c: Inline[]) => c.map((i) => i.text).join('').trim();
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'heading' || b.type === 'paragraph') parts.push(plain(b.content));
    else if (b.type === 'list') parts.push(b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '•'} ${plain(it)}`).join('\n'));
    else if (b.type === 'table') parts.push(b.rows.map((r) => r.join('\t')).join('\n'));
  }
  return parts.filter(Boolean).join('\n\n') + '\n';
}
