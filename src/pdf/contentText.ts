// Remoção de texto do fluxo de conteúdo de uma página.
//
// "Editar texto" precisa apagar o trecho original de verdade (não só cobri-lo), senão
// a busca e a cópia continuam encontrando o valor antigo. Aqui interpretamos os
// operadores de texto da página, localizamos os que desenham dentro das áreas
// indicadas e os trocamos por um deslocamento equivalente (TJ com espaçamento), para
// que o restante da linha não saia do lugar.

import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFRawStream, PDFRef, PDFStream,
  StandardFontEmbedder, StandardFonts, decodePDFRawStream,
} from 'pdf-lib';

type Matrix = [number, number, number, number, number, number];
type Value = number | string | Uint8Array | Value[] | { name: string } | { dict: true };

interface Op {
  op: string;
  args: Value[];
  start: number;
  end: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** Lê os operadores do fluxo de conteúdo, guardando a posição de cada um. */
export function parseContent(src: Uint8Array): Op[] {
  const ops: Op[] = [];
  let i = 0;
  let args: Value[] = [];
  let argStart = -1;
  const stack: Value[][] = [];

  const push = (v: Value, at: number) => {
    if (stack.length) stack[stack.length - 1].push(v);
    else {
      if (argStart < 0) argStart = at;
      args.push(v);
    }
  };

  while (i < src.length) {
    const c = src[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 0x25) { // comentário
      while (i < src.length && src[i] !== 0x0a && src[i] !== 0x0d) i++;
      continue;
    }
    const at = i;
    if (c === 0x28) { // (string literal)
      const out: number[] = [];
      let depth = 1;
      i++;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === 0x5c) { // barra invertida
          const n = src[i + 1];
          i += 2;
          const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
          if (n in map) out.push(map[n]);
          else if (n >= 0x30 && n <= 0x37) {
            let oct = n - 0x30;
            for (let k = 0; k < 2 && src[i] >= 0x30 && src[i] <= 0x37; k++) oct = oct * 8 + (src[i++] - 0x30);
            out.push(oct & 0xff);
          } else if (n === 0x0d) { if (src[i] === 0x0a) i++; }
          else if (n !== 0x0a) out.push(n);
          continue;
        }
        if (ch === 0x28) depth++;
        if (ch === 0x29 && --depth === 0) { i++; break; }
        out.push(ch);
        i++;
      }
      push(Uint8Array.from(out), at);
      continue;
    }
    if (c === 0x3c && src[i + 1] === 0x3c) { // << dicionário >> (só pulamos)
      let depth = 0;
      while (i < src.length) {
        if (src[i] === 0x3c && src[i + 1] === 0x3c) { depth++; i += 2; continue; }
        if (src[i] === 0x3e && src[i + 1] === 0x3e) { depth--; i += 2; if (depth === 0) break; continue; }
        if (src[i] === 0x28) { // string dentro do dicionário
          let d = 0;
          do {
            if (src[i] === 0x5c) i++;
            else if (src[i] === 0x28) d++;
            else if (src[i] === 0x29) d--;
            i++;
          } while (i < src.length && d > 0);
          continue;
        }
        i++;
      }
      push({ dict: true }, at);
      continue;
    }
    if (c === 0x3c) { // <hex>
      i++;
      let hex = '';
      while (i < src.length && src[i] !== 0x3e) {
        if (!WS.has(src[i])) hex += String.fromCharCode(src[i]);
        i++;
      }
      i++;
      if (hex.length % 2) hex += '0';
      const bytes = new Uint8Array(hex.length / 2);
      for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2), 16);
      push(bytes, at);
      continue;
    }
    if (c === 0x5b) {
      if (!stack.length && argStart < 0) argStart = at;
      stack.push([]);
      i++;
      continue;
    }
    if (c === 0x5d) { i++; const arr = stack.pop() ?? []; push(arr, at); continue; }
    if (c === 0x2f) { // /Nome
      i++;
      let name = '';
      while (i < src.length && !WS.has(src[i]) && !DELIM.has(src[i])) name += String.fromCharCode(src[i++]);
      push({ name }, at);
      continue;
    }
    // número ou operador
    let tok = '';
    while (i < src.length && !WS.has(src[i]) && !DELIM.has(src[i])) tok += String.fromCharCode(src[i++]);
    if (!tok) { i++; continue; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      push(parseFloat(tok), at);
      continue;
    }
    if (tok === 'true' || tok === 'false' || tok === 'null') { push(tok, at); continue; }
    ops.push({ op: tok, args, start: argStart < 0 ? at : argStart, end: i });
    args = [];
    argStart = -1;
    if (tok === 'ID') {
      // Dados binários de imagem embutida até "EI".
      i++;
      while (i < src.length && !(src[i] === 0x45 && src[i + 1] === 0x49 && (i + 2 >= src.length || WS.has(src[i + 2])) && WS.has(src[i - 1]))) i++;
      i += 2;
      ops[ops.length - 1].end = i;
    }
  }
  return ops;
}

const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m: Matrix, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

interface FontInfo {
  twoByte: boolean;
  width: (code: number) => number; // em milésimos de unidade de texto
}

function fontInfo(dict: PDFDict | undefined): FontInfo {
  const fallback: FontInfo = { twoByte: false, width: () => 500 };
  if (!dict) return fallback;
  const subtype = dict.lookup(PDFName.of('Subtype'));
  if (subtype instanceof PDFName && subtype.asString() === '/Type0') {
    const desc = dict.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
    const dw = (desc.lookup(PDFName.of('DW')) as PDFNumber | undefined)?.asNumber() ?? 1000;
    const widths = new Map<number, number>();
    const w = desc.lookup(PDFName.of('W'));
    if (w instanceof PDFArray) {
      const arr = w.asArray().map((x) => desc.context.lookup(x));
      for (let k = 0; k < arr.length;) {
        const first = (arr[k] as PDFNumber).asNumber();
        const next = arr[k + 1];
        if (next instanceof PDFArray) {
          next.asArray().forEach((v, j) => widths.set(first + j, (desc.context.lookup(v) as PDFNumber).asNumber()));
          k += 2;
        } else {
          const last = (next as PDFNumber).asNumber();
          const val = (arr[k + 2] as PDFNumber).asNumber();
          for (let c = first; c <= last; c++) widths.set(c, val);
          k += 3;
        }
      }
    }
    return { twoByte: true, width: (c) => widths.get(c) ?? dw };
  }
  const widthsArr = dict.lookup(PDFName.of('Widths'));
  if (widthsArr instanceof PDFArray) {
    const first = (dict.lookup(PDFName.of('FirstChar')) as PDFNumber | undefined)?.asNumber() ?? 0;
    const vals = widthsArr.asArray().map((v) => (dict.context.lookup(v) as PDFNumber).asNumber());
    const fd = dict.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    const missing = (fd?.lookup(PDFName.of('MissingWidth')) as PDFNumber | undefined)?.asNumber() ?? 0;
    return { twoByte: false, width: (c) => vals[c - first] ?? missing };
  }
  const base = (dict.lookup(PDFName.of('BaseFont')) as PDFName | undefined)?.asString().slice(1) ?? '';
  if ((Object.values(StandardFonts) as string[]).includes(base)) {
    const emb = StandardFontEmbedder.for(base as never);
    return {
      twoByte: false,
      width: (c) => {
        try {
          return emb.widthOfTextAtSize(String.fromCharCode(c), 1000);
        } catch {
          return 500;
        }
      },
    };
  }
  return fallback;
}

interface TextState {
  font: FontInfo;
  size: number;
  tc: number;
  tw: number;
  th: number;
  rise: number;
  leading: number;
}

/**
 * Remove (substitui por espaçamento) as operações de texto cujo ponto médio cai
 * dentro de algum dos retângulos (coordenadas PDF da página). Devolve quantas removeu.
 */
export function removeTextInRects(doc: PDFDocument, page: PDFPage, rects: Rect[]): number {
  const contents = page.node.Contents();
  if (!contents) return 0;
  const streams = contents instanceof PDFArray
    ? contents.asArray().map((r) => doc.context.lookup(r) as PDFStream)
    : [contents as PDFStream];
  const parts = streams.map((s) => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()));
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const src = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    src.set(p, off);
    off += p.length;
    src[off++] = 0x0a;
  }

  const fontsDict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const fontCache = new Map<string, FontInfo>();
  const getFont = (name: string) => {
    let f = fontCache.get(name);
    if (!f) {
      let dict: PDFDict | undefined;
      try {
        dict = fontsDict?.lookupMaybe(PDFName.of(name), PDFDict);
      } catch {
        dict = undefined;
      }
      f = fontInfo(dict);
      fontCache.set(name, f);
    }
    return f;
  };

  const ops = parseContent(src);
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const gstack: { ctm: Matrix; ts: TextState }[] = [];
  let ts: TextState = { font: { twoByte: false, width: () => 500 }, size: 0, tc: 0, tw: 0, th: 1, rise: 0, leading: 0 };
  let tm: Matrix = [1, 0, 0, 1, 0, 0];
  let tlm: Matrix = [1, 0, 0, 1, 0, 0];
  const edits: { start: number; end: number; text: string }[] = [];

  const advance = (str: Uint8Array): number => {
    let w = 0;
    const step = ts.font.twoByte ? 2 : 1;
    for (let k = 0; k + step - 1 < str.length; k += step) {
      const code = step === 2 ? (str[k] << 8) | str[k + 1] : str[k];
      w += (ts.font.width(code) / 1000) * ts.size + ts.tc + (step === 1 && code === 32 ? ts.tw : 0);
    }
    return w * ts.th;
  };

  const show = (items: Value[], op: Op) => {
    let tx = 0;
    for (const it of items) {
      if (it instanceof Uint8Array) tx += advance(it);
      else if (typeof it === 'number') tx -= (it / 1000) * ts.size * ts.th;
    }
    const m = mul(tm, ctm);
    const a = apply(m, 0, ts.rise);
    const b = apply(m, tx, ts.rise);
    const up = apply(m, 0, ts.rise + ts.size * 0.35);
    const dx = up.x - a.x;
    const dy = up.y - a.y;
    // Só remove se praticamente todo o trecho estiver dentro da área: nunca apaga texto
    // visível fora do que o usuário selecionou.
    const hit = rects.some((r) => {
      let inside = 0;
      for (let k = 0; k <= 10; k++) {
        const x = a.x + ((b.x - a.x) * k) / 10 + dx;
        const y = a.y + ((b.y - a.y) * k) / 10 + dy;
        if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) inside++;
      }
      return inside >= 9;
    });
    if (hit) {
      const units = ts.size * ts.th ? -(tx / (ts.size * ts.th)) * 1000 : 0;
      let repl = `[${units.toFixed(3)}] TJ`;
      if (op.op === "'" || op.op === '"') {
        repl = (op.op === '"' ? `${op.args[0]} Tw ${op.args[1]} Tc ` : '') + 'T* ' + repl;
      }
      edits.push({ start: op.start, end: op.end, text: repl });
    }
    tm = mul([1, 0, 0, 1, tx, 0], tm);
  };

  for (const op of ops) {
    const n = (k: number) => (typeof op.args[k] === 'number' ? (op.args[k] as number) : 0);
    switch (op.op) {
      case 'q': gstack.push({ ctm, ts: { ...ts } }); break;
      case 'Q': { const g = gstack.pop(); if (g) { ctm = g.ctm; ts = g.ts; } break; }
      case 'cm': ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], ctm); break;
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
      case 'Tf': {
        const name = op.args[0] as { name: string } | undefined;
        if (name?.name) ts.font = getFont(name.name);
        ts.size = n(1);
        break;
      }
      case 'Tc': ts.tc = n(0); break;
      case 'Tw': ts.tw = n(0); break;
      case 'Tz': ts.th = n(0) / 100; break;
      case 'TL': ts.leading = n(0); break;
      case 'Ts': ts.rise = n(0); break;
      case 'Td': tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm); tm = tlm; break;
      case 'TD': ts.leading = -n(1); tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm); tm = tlm; break;
      case 'Tm': tlm = [n(0), n(1), n(2), n(3), n(4), n(5)]; tm = tlm; break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -ts.leading], tlm); tm = tlm; break;
      case 'Tj': if (op.args[0] instanceof Uint8Array) show([op.args[0]], op); break;
      case 'TJ': if (Array.isArray(op.args[0])) show(op.args[0], op); break;
      case "'":
      case '"': {
        if (op.op === '"') { ts.tw = n(0); ts.tc = n(1); }
        tlm = mul([1, 0, 0, 1, 0, -ts.leading], tlm);
        tm = tlm;
        const s = op.args[op.args.length - 1];
        if (s instanceof Uint8Array) show([s], op);
        break;
      }
    }
  }
  if (!edits.length) return 0;

  const chunks: Uint8Array[] = [];
  let pos = 0;
  const enc = new TextEncoder();
  for (const e of edits.sort((x, y) => x.start - y.start)) {
    chunks.push(src.subarray(pos, e.start), enc.encode(e.text));
    pos = e.end;
  }
  chunks.push(src.subarray(pos));
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  const ref: PDFRef = doc.context.register(doc.context.flateStream(out));
  page.node.set(PDFName.of('Contents'), ref);
  return edits.length;
}
