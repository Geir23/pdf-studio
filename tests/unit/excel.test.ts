import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { pageTable, parseNumber, pdfToXlsx } from '../../src/pdf/excel';

const fixture = join(__dirname, '..', 'fixtures', 'libreoffice-tabela.pdf');
const open = async () => pdfjs.getDocument({ data: new Uint8Array(readFileSync(fixture)) }).promise;

describe('exportar para Excel', () => {
  it('interpreta números no formato brasileiro', () => {
    expect(parseNumber('1.234,50')).toBe(1234.5);
    expect(parseNumber('R$ 12,40')).toBe(12.4);
    expect(parseNumber('45')).toBe(45);
    expect(parseNumber('12%')).toBe(0.12);
    expect(parseNumber('01310-100')).toBeNull();
    expect(parseNumber('Caneta')).toBeNull();
  });

  it('reconstrói a tabela em linhas e colunas', async () => {
    const rows = await pageTable(await open() as never, 0);
    expect(rows[0][0]).toBe('Relatório de vendas – 2026');
    const body = rows.slice(1).map((r) => r.filter((c) => c !== null));
    expect(body).toEqual([
      ['Produto', 'Quantidade', 'Valor (R$)'],
      ['Caneta azul', 120, 1234.5],
      ['Caderno universitário', 45, 987],
      ['Borracha', 8, 12.4],
    ]);
  });

  const hasSoffice = spawnSync('soffice', ['--version']).status === 0;
  it.runIf(hasSoffice)('gera um .xlsx que o LibreOffice abre', async () => {
    const xlsx = await pdfToXlsx(await open() as never);
    const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
    writeFileSync(join(dir, 'tabela.xlsx'), xlsx);
    execFileSync('soffice', ['--headless', '--convert-to', 'csv', '--outdir', dir, join(dir, 'tabela.xlsx')], { timeout: 120_000 });
    const csv = readFileSync(join(dir, 'tabela.csv'), 'utf8');
    expect(csv).toContain('Caderno universitário,45,987');
    expect(csv).toContain('Caneta azul,120,1234.5');
  }, 150_000);
});
