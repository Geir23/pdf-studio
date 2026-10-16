// Exportação para Excel (.xlsx): reconstrói linhas e colunas a partir da posição do texto.
import JSZip from 'jszip';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

export type Cell = string | number | null;

interface Piece {
  x0: number;
  x1: number;
  y: number;
  size: number;
  str: string;
}

const mul = (a: number[], b: number[]) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

/** "1.234,56", "R$ 12,40", "45", "-3,5%" → número; o resto continua texto. */
export function parseNumber(s: string): number | null {
  const t = s.trim().replace(/^R\$\s*/, '');
  const pct = t.endsWith('%');
  const core = pct ? t.slice(0, -1).trim() : t;
  let n: number;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(core) || /^-?\d+,\d+$/.test(core)) n = Number(core.replace(/\./g, '').replace(',', '.'));
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(core)) n = Number(core.replace(/,/g, ''));
  else if (/^-?\d+(\.\d+)?$/.test(core)) {
    if (/^0\d/.test(core.replace('-', ''))) return null; // códigos com zero à esquerda (CEP, CPF…)
    n = Number(core);
  } else return null;
  return Number.isFinite(n) ? (pct ? n / 100 : n) : null;
}

/** Linhas → células de uma página, agrupando por posição. */
export async function pageTable(view: PDFDocumentProxy, index: number): Promise<Cell[][]> {
  const page = await view.getPage(index + 1);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const pieces: Piece[] = [];
  for (const raw of content.items) {
    if (!('str' in raw)) continue;
    const it = raw as TextItem;
    if (!it.str.trim()) continue;
    const m = mul(vp.transform, it.transform);
    const size = Math.hypot(m[2], m[3]) || 10;
    pieces.push({ x0: m[4], x1: m[4] + it.width, y: m[5], size, str: it.str });
  }
  // 1) linhas: textos com a mesma linha de base
  pieces.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const rows: Piece[][] = [];
  for (const p of pieces) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - p.y) < Math.max(row[0].size, p.size) * 0.5) row.push(p);
    else rows.push([p]);
  }
  // 2) células: trechos da linha separados por um vão maior que ~1 caractere
  const cellRows = rows.map((row) => {
    row.sort((a, b) => a.x0 - b.x0);
    const cells: Piece[] = [];
    for (const p of row) {
      const last = cells[cells.length - 1];
      if (last && p.x0 - last.x1 < Math.max(p.size, last.size) * 0.9) {
        last.str += (p.x0 - last.x1 > p.size * 0.15 && !last.str.endsWith(' ') ? ' ' : '') + p.str;
        last.x1 = Math.max(last.x1, p.x1);
      } else cells.push({ ...p });
    }
    return cells;
  });
  // 3) colunas: faixas horizontais que se sobrepõem (funciona para alinhamento à direita)
  const cols: { x0: number; x1: number }[] = [];
  for (const cells of cellRows) {
    if (cells.length < 2) continue; // títulos de uma célula não definem colunas
    for (const c of cells) {
      const col = cols.find((k) => c.x0 < k.x1 && c.x1 > k.x0);
      if (col) {
        col.x0 = Math.min(col.x0, c.x0);
        col.x1 = Math.max(col.x1, c.x1);
      } else cols.push({ x0: c.x0, x1: c.x1 });
    }
  }
  cols.sort((a, b) => a.x0 - b.x0);
  const colOf = (c: Piece) => {
    const i = cols.findIndex((k) => c.x0 < k.x1 && c.x1 > k.x0);
    if (i >= 0) return i;
    const after = cols.findIndex((k) => k.x0 > c.x0);
    return after === -1 ? Math.max(cols.length - 1, 0) : Math.max(after - 1, 0);
  };
  return cellRows.map((cells) => {
    const out: Cell[] = Array(Math.max(cols.length, 1)).fill(null);
    for (const c of cells) {
      const i = cells.length < 2 ? 0 : colOf(c);
      const text = c.str.trim();
      const prev = out[i];
      out[i] = prev === null ? parseNumber(text) ?? text : `${prev} ${text}`;
    }
    return out;
  });
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
    // caracteres de controle não são permitidos em XML
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function colName(i: number) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Gera um .xlsx mínimo (Office Open XML), uma planilha por página. */
export async function writeXlsx(sheets: { name: string; rows: Cell[][] }[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const n = sheets.length;
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  const used = new Set<string>();
  const names = sheets.map((s) => {
    let base = s.name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 28) || 'Planilha';
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base} ${k}`;
    used.add(name.toLowerCase());
    base = name;
    return base;
  });
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((nm, i) => `<sheet name="${esc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`);
  sheets.forEach((s, i) => {
    const widths = new Map<number, number>();
    const rows = s.rows.map((row, r) => {
      const cells = row.map((v, c) => {
        if (v === null || v === '') return '';
        const ref = `${colName(c)}${r + 1}`;
        widths.set(c, Math.max(widths.get(c) ?? 8, Math.min(60, String(v).length + 2)));
        return typeof v === 'number'
          ? `<c r="${ref}"><v>${v}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    const cols = [...widths.entries()].sort((a, b) => a[0] - b[0])
      .map(([c, w]) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('');
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows}</sheetData></worksheet>`);
  });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function pdfToXlsx(view: PDFDocumentProxy, onProgress?: (f: number) => void): Promise<Uint8Array> {
  const sheets: { name: string; rows: Cell[][] }[] = [];
  for (let i = 0; i < view.numPages; i++) {
    sheets.push({ name: `Página ${i + 1}`, rows: await pageTable(view, i) });
    onProgress?.((i + 1) / view.numPages);
  }
  return writeXlsx(sheets);
}
