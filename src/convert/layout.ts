// Reconstrução da estrutura (títulos, parágrafos, listas, tabelas, colunas) a partir da
// posição dos trechos de texto. Funções puras: recebem PageData, devolvem blocos.
import { parseNumber } from '../pdf/excel';
import type { Block, Inline, PageData, Rect, TextPiece } from './types';

interface Fragment {
  items: TextPiece[];
  x0: number;
  x1: number;
  baseline: number;
  size: number;
  top: number;
  bottom: number;
}

interface Line extends Fragment {
  text: string;
  bold: boolean;
}

const BULLET = /^([•●▪◦‣∙·○■□➢➤►▸–—\-*]|[-])$/;
const MARKER = /^(?:([•●▪◦‣∙·○■□➢➤►▸–—\-*]|[-])|(\d{1,3}[.)]|[a-zA-Z][.)]|[ivxlcdm]{1,6}[.)]))\s+/i;
// Pronomes que seguem hífen no fim de linha e NÃO são quebra de palavra ("recomenda-se").
const CLITICS = new Set(['se', 'me', 'te', 'lhe', 'lhes', 'nos', 'vos', 'o', 'a', 'os', 'as', 'lo', 'la', 'los', 'las', 'no', 'na', 'nas', 'mo', 'ma', 'to', 'ta', 'lhe']);

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function frag(items: TextPiece[]): Fragment {
  const size = median(items.map((i) => i.size));
  const baseline = median(items.map((i) => i.baseline));
  return {
    items,
    x0: Math.min(...items.map((i) => i.x0)),
    x1: Math.max(...items.map((i) => i.x1)),
    baseline,
    size,
    top: baseline - size * 0.8,
    bottom: baseline + size * 0.25,
  };
}

/** Junta trechos da mesma linha de base que estão próximos; vãos grandes viram fragmentos separados. */
export function buildFragments(items: TextPiece[]): Fragment[] {
  // Trechos só de espaço são ignorados: o pdf.js os usa para preencher vãos (ex.: entre
  // células de tabela), o que emendaria colunas. O espaçamento sai da distância entre trechos.
  const sorted = items.filter((i) => i.str.trim()).sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const open: TextPiece[][] = [];
  for (const it of sorted) {
    const target = open.find((f) => {
      const last = f[f.length - 1];
      const tol = Math.min(last.size, it.size) * 0.45;
      return Math.abs(last.baseline - it.baseline) < tol && it.x0 - last.x1 < Math.max(last.size, it.size) * 1.6 && it.x0 - last.x1 > -last.size;
    });
    if (target) target.push(it);
    else open.push([it]);
  }
  return open.map((f) => frag(f.sort((a, b) => a.x0 - b.x0))).filter((f) => f.items.some((i) => i.str.trim()));
}

function fragText(f: Fragment): string {
  let out = '';
  let prev: TextPiece | null = null;
  for (const it of f.items) {
    if (prev && (it.ocr || it.x0 - prev.x1 > it.size * 0.15) && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' ';
    out += it.str;
    prev = it;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ---------------- cabeçalhos e rodapés repetidos ----------------

const normKey = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const PAGE_NUMBER = /^(p[áa]g(ina)?\.?\s*)?#(\s*(de|of|\/)\s*#)?$|^-\s*#\s*-$/;

export function findRepeated(pages: PageData[]): Set<string> {
  const counts = new Map<string, number>();
  for (const p of pages) {
    const keys = new Set<string>();
    for (const f of buildFragments(p.items)) {
      if (f.top > p.height * 0.1 && f.bottom < p.height * 0.9) continue;
      keys.add(normKey(fragText(f)));
    }
    keys.forEach((k) => counts.set(k, (counts.get(k) ?? 0) + 1));
  }
  const min = Math.max(2, Math.ceil(pages.length * 0.5));
  return new Set([...counts].filter(([, n]) => n >= min).map(([k]) => k));
}

function isFurniture(f: Fragment, p: PageData, repeated: Set<string>) {
  if (f.top > p.height * 0.1 && f.bottom < p.height * 0.9) return false;
  const key = normKey(fragText(f));
  return repeated.has(key) || PAGE_NUMBER.test(key);
}

// ---------------- colunas ----------------

/** Ordem de leitura: detecta um vão vertical (duas colunas) e lê a esquerda antes da direita. */
export function readingOrder(frags: Fragment[], width: number): Fragment[][] {
  const byTop = (a: Fragment, b: Fragment) => a.top - b.top || a.x0 - b.x0;
  const narrow = frags.filter((f) => f.x1 - f.x0 < width * 0.55);
  if (narrow.length < 8) return [frags.sort(byTop)];
  let best: { x: number; run: number } | null = null;
  let runStart = -1;
  const allowed = Math.max(1, Math.floor(narrow.length * 0.03));
  for (let x = Math.floor(width * 0.3); x <= Math.ceil(width * 0.7); x++) {
    const crossing = narrow.filter((f) => f.x0 < x && f.x1 > x).length;
    if (crossing <= allowed) {
      if (runStart < 0) runStart = x;
      const run = x - runStart + 1;
      if (!best || run > best.run) best = { x: runStart + run / 2, run };
    } else runStart = -1;
  }
  if (!best || best.run < width * 0.015) return [frags.sort(byTop)];
  const g = best.x;
  const left = frags.filter((f) => f.x1 <= g + 1);
  const right = frags.filter((f) => f.x0 >= g - 1);
  const span = frags.filter((f) => !left.includes(f) && !right.includes(f));
  if (left.length < 4 || right.length < 4) return [frags.sort(byTop)];
  // Colunas de verdade ocupam boa parte da altura, lado a lado (evita confundir tabelas).
  const spanOf = (fs: Fragment[]) => [Math.min(...fs.map((f) => f.top)), Math.max(...fs.map((f) => f.bottom))];
  const [lt, lb] = spanOf(left);
  const [rt, rb] = spanOf(right);
  const overlap = Math.min(lb, rb) - Math.max(lt, rt);
  const minSpan = Math.min(lb - lt, rb - rt);
  if (minSpan < frags[0].size * 8 || overlap < minSpan * 0.6) return [frags.sort(byTop)];
  const rightLines = right.length;
  const leftLines = left.length;
  if (Math.min(leftLines, rightLines) < Math.max(leftLines, rightLines) * 0.15) return [frags.sort(byTop)];
  const zoneTop = Math.min(...right.map((f) => f.top));
  const zoneBottom = Math.max(...right.map((f) => f.bottom));
  // Texto da esquerda acima da coluna direita (ex.: título curto à esquerda) vem primeiro.
  const above = [...span.filter((f) => f.bottom <= zoneTop + 2), ...left.filter((f) => f.bottom <= zoneTop + 2)];
  const below = span.filter((f) => f.top >= zoneBottom - 2);
  const middleSpan = span.filter((f) => !above.includes(f) && !below.includes(f));
  const leftCol = left.filter((f) => !above.includes(f));
  return [above.sort(byTop), [...leftCol, ...middleSpan].sort(byTop), right.sort(byTop), below.sort(byTop)].filter((r) => r.length);
}

// ---------------- linhas, tabelas, parágrafos ----------------

interface Row {
  frags: Fragment[];
  baseline: number;
}

function rows(region: Fragment[]): Row[] {
  const out: Row[] = [];
  for (const f of [...region].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)) {
    const r = out[out.length - 1];
    if (r && Math.abs(r.baseline - f.baseline) < f.size * 0.45) r.frags.push(f);
    else out.push({ frags: [f], baseline: f.baseline });
  }
  for (const r of out) {
    r.frags.sort((a, b) => a.x0 - b.x0);
    // "•" ou "1." separado do texto por um vão: é item de lista, não tabela.
    if (r.frags.length >= 2 && fragText(r.frags[0]).length <= 4 && (BULLET.test(fragText(r.frags[0])) || /^(\d{1,3}|[a-z])[.)]$/i.test(fragText(r.frags[0])))) {
      r.frags = [frag(r.frags.flatMap((f) => f.items))];
    }
  }
  return out;
}

function toLine(f: Fragment): Line {
  const text = fragText(f);
  const letters = f.items.filter((i) => i.str.trim());
  return { ...f, text, bold: letters.length > 0 && letters.every((i) => i.bold) };
}

function cellText(fs: Fragment[]) {
  return fs.map(fragText).join(' ').trim();
}

interface TableResult {
  rows: string[][];
  top: number;
  bottom: number;
  end: number;
}

/** Tenta formar uma tabela a partir da linha `start` (precisa de 2+ linhas com 2+ células alinhadas). */
function tryTable(all: Row[], start: number): TableResult | null {
  const isMulti = (r: Row) => r.frags.length >= 2;
  if (!isMulti(all[start])) return null;
  let end = start;
  const cols: { x0: number; x1: number }[] = [];
  const addCols = (r: Row) => {
    for (const f of r.frags) {
      const c = cols.find((k) => f.x0 < k.x1 && f.x1 > k.x0);
      if (c) {
        c.x0 = Math.min(c.x0, f.x0);
        c.x1 = Math.max(c.x1, f.x1);
      } else cols.push({ x0: f.x0, x1: f.x1 });
    }
  };
  addCols(all[start]);
  const tableRows: Fragment[][][] = [];
  const place = (r: Row) => {
    cols.sort((a, b) => a.x0 - b.x0);
    const cells: Fragment[][] = cols.map(() => []);
    for (const f of r.frags) {
      let i = cols.findIndex((k) => f.x0 < k.x1 && f.x1 > k.x0);
      if (i < 0) i = Math.max(0, cols.findIndex((k) => k.x0 > f.x0) - 1);
      cells[i].push(f);
    }
    return cells;
  };
  tableRows.push(place(all[start]));
  for (let i = start + 1; i < all.length; i++) {
    const r = all[i];
    const prev = all[i - 1];
    const gap = r.baseline - prev.baseline;
    if (gap > r.frags[0].size * 4) break;
    if (isMulti(r)) {
      // As células precisam cair (quase todas) em colunas já vistas.
      const hits = r.frags.filter((f) => cols.some((k) => f.x0 < k.x1 && f.x1 > k.x0)).length;
      if (hits < Math.max(1, r.frags.length - 1)) break;
      addCols(r);
      tableRows.push(place(r));
      end = i;
    } else if (end > start || tableRows.length >= 1) {
      // Texto quebrado dentro de uma célula: uma linha só, alinhada a uma coluna existente.
      const f = r.frags[0];
      const col = cols.findIndex((k) => f.x0 >= k.x0 - 2 && f.x1 <= k.x1 + f.size * 6);
      if (col < 0 || gap > f.size * 1.6 || i === all.length - 1) break;
      const next = all[i + 1];
      if (!isMulti(next)) break;
      tableRows[tableRows.length - 1][col]?.push(f);
      end = i;
    }
  }
  if (tableRows.length < 2 || cols.length < 2) return null;
  const rowsText = tableRows.map((cells) => cols.map((_, c) => cellText(cells[c] ?? [])));
  // Precisa ter cara de tabela: maioria das linhas com 2+ células preenchidas.
  const full = rowsText.filter((r) => r.filter(Boolean).length >= 2).length;
  if (full < 2 || full < rowsText.length * 0.6) return null;
  return {
    rows: rowsText,
    top: Math.min(...tableRows.flat(2).map((f) => f.top)),
    bottom: Math.max(...tableRows.flat(2).map((f) => f.bottom)),
    end,
  };
}

function inlines(lines: Line[]): Inline[] {
  const out: Inline[] = [];
  const push = (text: string, it: TextPiece | null) => {
    const last = out[out.length - 1];
    const fmt = { bold: !!it?.bold, italic: !!it?.italic, link: it?.link };
    if (last && !!last.bold === fmt.bold && !!last.italic === fmt.italic && last.link === fmt.link) last.text += text;
    else if (last && !text.trim()) last.text += text;
    else out.push({ text, ...(fmt.bold ? { bold: true } : {}), ...(fmt.italic ? { italic: true } : {}), ...(fmt.link ? { link: fmt.link } : {}) });
  };
  lines.forEach((line, li) => {
    if (li > 0) {
      const prevText = out.map((o) => o.text).join('');
      const m = prevText.match(/([A-Za-zÀ-ÿ]{2,})-$/);
      const nextWord = line.text.match(/^([a-zà-ÿ]+)/)?.[1];
      if (m && nextWord && !CLITICS.has(nextWord.toLowerCase())) {
        // Palavra hifenizada na quebra de linha: "exem-" + "plo" → "exemplo".
        const last = out[out.length - 1];
        last.text = last.text.replace(/-$/, '');
      } else if (!(m && nextWord)) push(' ', null); // "recomenda-" + "se" → "recomenda-se" (sem espaço)
    }
    let prev: TextPiece | null = null;
    for (const it of line.items) {
      // Palavras do OCR são sempre separadas; no texto do PDF, decide o vão entre trechos.
      if (prev && (it.ocr || it.x0 - prev.x1 > it.size * 0.15) && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) push(' ', null);
      push(it.str, it);
      prev = it;
    }
  });
  for (const o of out) o.text = o.text.replace(/\s+/g, ' ');
  if (out.length) {
    out[0].text = out[0].text.replace(/^\s+/, '');
    out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
  }
  return out.filter((o) => o.text);
}

function stripMarker(content: Inline[]): { content: Inline[]; ordered: boolean } {
  const first = content[0];
  const m = first?.text.match(MARKER);
  if (!m) return { content, ordered: false };
  // Remove também traços que o OCR às vezes lê junto do marcador ("• —Texto").
  const rest = [{ ...first, text: first.text.slice(m[0].length).replace(/^[—–\-•*·]+\s*/, '') }, ...content.slice(1)].filter((c) => c.text);
  return { content: rest, ordered: !!m[2] && !/^[a-z][.)]$/i.test(m[2]) };
}

interface Para {
  lines: Line[];
  top: number;
  bottom: number;
}

function paragraphs(lines: Line[], colRight: number, colLeft: number): Para[] {
  const out: Para[] = [];
  let cur: Para | null = null;
  const width = Math.max(1, colRight - colLeft);
  for (const l of lines) {
    let brk = !cur;
    if (cur) {
      const p = cur.lines[cur.lines.length - 1];
      const spacing = l.baseline - p.baseline;
      const sizeRatio = l.size / p.size;
      const prevShort = p.x1 < colRight - width * 0.15 && /[.!?:;]$/.test(p.text);
      const marker = MARKER.test(l.text);
      const inList = MARKER.test(cur.lines[0].text);
      const indentJump = l.x0 > p.x0 + l.size * 1.2 && !inList;
      brk =
        spacing > Math.max(p.size, l.size) * 1.5 ||
        spacing < 0 ||
        sizeRatio > 1.12 || sizeRatio < 0.89 ||
        l.bold !== p.bold && (l.text.length < 90 || p.text.length < 90) ||
        marker ||
        (prevShort && !inList) ||
        (inList && l.x0 < cur.lines[0].x0 + 1 && !marker && prevShort) ||
        indentJump;
    }
    if (brk) {
      cur = { lines: [l], top: l.top, bottom: l.bottom };
      out.push(cur);
    } else {
      cur!.lines.push(l);
      cur!.bottom = l.bottom;
    }
  }
  return out;
}

interface Placed {
  top: number;
  block: Block;
}

/** Converte uma página em blocos na ordem de leitura. */
export function layoutPage(page: PageData, repeated: Set<string>, bodySize: number, images: { rect: Rect; block: Block }[] = []): Block[] {
  const frags = buildFragments(page.items).filter((f) => !isFurniture(f, page, repeated));
  const regions = readingOrder(frags, page.width);
  const blocks: Block[] = [];
  const pendingImages = [...images].sort((a, b) => a.rect.y - b.rect.y);
  for (const region of regions) {
    const placed: Placed[] = [];
    const rs = rows(region);
    const colLeft = Math.min(...region.map((f) => f.x0));
    const colRight = Math.max(...region.map((f) => f.x1));
    let lineBuf: Line[] = [];
    const flush = () => {
      for (const p of paragraphs(lineBuf, colRight, colLeft)) {
        const text = p.lines.map((l) => l.text).join(' ');
        // Parágrafo de 1–3 sinais soltos (ex.: ";" de sujeira na digitalização) é ruído.
        if ((text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 2 && text.length <= 3) continue;
        placed.push({ top: p.top, block: classify(p, page.index, bodySize) });
      }
      lineBuf = [];
    };
    for (let i = 0; i < rs.length; i++) {
      const t = tryTable(rs, i);
      if (t) {
        flush();
        placed.push({ top: t.top, block: { type: 'table', rows: t.rows, page: page.index } });
        i = t.end;
        continue;
      }
      for (const f of rs[i].frags) lineBuf.push(toLine(f));
    }
    flush();
    // Imagens desta região (pelo centro horizontal), na posição vertical.
    const regionImages = pendingImages.filter((im) => {
      const cx = im.rect.x + im.rect.w / 2;
      return cx >= colLeft - 20 && cx <= colRight + 20;
    });
    for (const im of regionImages) {
      placed.push({ top: im.rect.y, block: im.block });
      pendingImages.splice(pendingImages.indexOf(im), 1);
    }
    placed.sort((a, b) => a.top - b.top);
    blocks.push(...mergeLists(placed.map((p) => p.block)));
  }
  for (const im of pendingImages) blocks.push(im.block);
  return blocks;
}

function classify(p: Para, page: number, bodySize: number): Block {
  const content = inlines(p.lines);
  const text = content.map((c) => c.text).join('');
  const size = median(p.lines.map((l) => l.size));
  const ratio = size / (bodySize || size);
  const words = text.split(/\s+/).filter(Boolean).length;
  const allBold = p.lines.every((l) => l.bold);
  if (MARKER.test(p.lines[0].text) && !(p.lines.length === 1 && /^\d{1,3}[.)]\s+\d/.test(text))) {
    const { content: item, ordered } = stripMarker(content);
    return { type: 'list', ordered, items: [item], page };
  }
  const fromImage = p.lines.every((l) => l.items.every((i) => i.fromImage));
  const looksTitle = !fromImage && p.lines.length <= 3 && words <= 20 && !/[.,;]$/.test(text) && parseNumber(text) === null;
  if (looksTitle && (ratio >= 1.12 || (allBold && words <= 14 && ratio > 0.95))) {
    return { type: 'heading', level: 0, content: content.map(({ bold: _b, ...c }) => c), page, size: allBold && ratio < 1.12 ? 0 : size };
  }
  return { type: 'paragraph', content, page };
}

/** Itens de lista consecutivos do mesmo tipo viram uma lista só. */
function mergeLists(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.type === 'list' && last?.type === 'list' && last.ordered === b.ordered) last.items.push(...b.items);
    else out.push(b);
  }
  return out;
}

/** Tamanho de corpo do documento (mediana ponderada pela quantidade de caracteres). */
export function bodyFontSize(pages: PageData[]): number {
  const weights = new Map<number, number>();
  for (const p of pages) for (const it of p.items) {
    const k = Math.round(it.size * 2) / 2;
    weights.set(k, (weights.get(k) ?? 0) + it.str.length);
  }
  let best = 0;
  let max = -1;
  for (const [k, w] of weights) if (w > max) [best, max] = [k, w];
  return best || 11;
}

/** Níveis de título pelo tamanho da fonte em todo o documento; parágrafos quebrados entre colunas/páginas são unidos. */
export function finalizeBlocks(blocks: Block[]): Block[] {
  // Agrupa tamanhos parecidos (±10%): o OCR mede cada linha com pequenas variações.
  const raw = blocks.flatMap((b) => (b.type === 'heading' && b.size ? [b.size] : [])).sort((a, b) => b - a);
  const sizes: number[] = [];
  for (const sz of raw) if (!sizes.some((t) => Math.abs(t - sz) / t < 0.1)) sizes.push(sz);
  const levelOf = (s: number) => (s ? sizes.findIndex((t) => Math.abs(t - s) / t < 0.1) + 1 || sizes.length : sizes.length + 1);
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type === 'heading') {
      out.push({ ...b, level: Math.min(6, levelOf(b.size ?? 0)) });
      continue;
    }
    const last = out[out.length - 1];
    if (b.type === 'paragraph' && last?.type === 'paragraph') {
      const prevText = last.content.map((c) => c.text).join('');
      const first = b.content[0]?.text ?? '';
      if (!/[.!?:;)"”»]$/.test(prevText) && /^[a-zà-ÿ]/.test(first)) {
        last.content.push({ text: ' ' }, ...b.content);
        continue;
      }
    }
    out.push(b);
  }
  return out;
}
