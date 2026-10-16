// Teste do Conversor no Chromium. Uso: npm run build && node tests/e2e/converter.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const OUT = join(process.cwd(), 'test-output', 'conversor');
mkdirSync(OUT, { recursive: true });
const FIX = join(process.cwd(), 'tests', 'fixtures', 'convert');
const PORT = 4183;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve());
  setTimeout(() => reject(new Error('servidor não iniciou')), 20000);
});
const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: existsSync(exe) ? exe : undefined });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.getByRole('tab', { name: 'Conversor' }).click();
  const files = ['relatorio.pdf', 'relatorio-escaneado.pdf', 'relatorio-texto-ilegivel.pdf', 'grafico.png', 'relatorio.docx'];
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.conv-drop').click();
  await (await chooser).setFiles(files.map((f) => join(FIX, f)));
  await page.locator('.conv-jobs li').nth(4).waitFor();
  await page.locator('.conv-options select').nth(1).selectOption('auto');
  await page.locator('.conv-options select').nth(2).selectOption('por');
  await page.getByRole('button', { name: 'Converter', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.conv-jobs li.pronto, .conv-jobs li.erro').length === 5, null, { timeout: 600000 });
  const statuses = await page.locator('.conv-jobs li').evaluateAll((els) => els.map((e) => e.className));
  check('converte os 5 arquivos do lote', statuses.every((c) => c.includes('pronto')), statuses.join(' | '));

  const info = await page.locator('.conv-jobs li small').allInnerTexts();
  check('OCR aplicado no escaneado e no texto ilegível', /OCR em 2 pág/.test(info[1]) && /OCR em 2 pág/.test(info[2]), info.join(' / '));

  // Pré-visualização do primeiro arquivo
  await page.locator('.conv-jobs li').nth(0).click();
  await page.locator('.md-preview h1').waitFor();
  check('pré-visualização mostra título e tabela', (await page.locator('.md-preview h1').innerText()) === 'Relatório Técnico de Avaliação' && (await page.locator('.md-preview table tr').count()) === 4);
  check('pré-visualização mostra a imagem', (await page.locator('.md-preview img').count()) === 1);
  await page.screenshot({ path: join(OUT, '01-conversor.png') });
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const md = await page.locator('.md-source').inputValue();
  check('aba Markdown com a tabela', md.includes('| Sul | 1.250 | 92% |'));

  // Escaneado
  await page.locator('.conv-jobs li').nth(1).click();
  const scanned = await page.locator('.md-source').inputValue();
  check('escaneado vira texto estruturado', scanned.includes('## Objetivos') && scanned.includes('| Nordeste | 2.105 | 85% |'));
  await page.getByRole('button', { name: 'Visualizar' }).click();
  check('aviso de OCR para conferência', (await page.locator('.conv-note').count()) === 1);

  // Baixar um (Markdown + imagens)
  await page.locator('.conv-jobs li').nth(0).click();
  let dl = page.waitForEvent('download');
  await page.locator('.conv-toolbar button.primary').click();
  const one = join(OUT, 'relatorio.zip');
  await (await dl).saveAs(one);
  const zip1 = await JSZip.loadAsync(await readFile(one));
  check('baixa .zip com Markdown e imagens', !!zip1.file('relatorio.md') && !!zip1.file('imagens/pagina1-imagem1.png'), Object.keys(zip1.files).join(', '));

  // Baixar todos em Word
  await page.locator('.conv-options select').nth(0).selectOption('docx');
  dl = page.waitForEvent('download');
  await page.getByRole('button', { name: /Baixar todos/ }).click();
  const all = join(OUT, 'convertidos.zip');
  await (await dl).saveAs(all);
  const zipAll = await JSZip.loadAsync(await readFile(all));
  const names = Object.keys(zipAll.files).sort();
  check('baixa todos em Word (.zip)', names.length === 5 && names.every((n) => n.endsWith('.docx')), names.join(', '));

  // Do editor para o Conversor
  await page.getByRole('tab', { name: 'Editor' }).click();
  const ch2 = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Abrir arquivo' }).click();
  await (await ch2).setFiles(join(FIX, 'relatorio.pdf'));
  await page.locator('.page[data-page="0"] canvas:not(.loading)').waitFor();
  await page.getByRole('button', { name: 'Ferramentas' }).click();
  await page.locator('.tool-card', { hasText: 'Converter (Markdown' }).click();
  await page.locator('.conv-jobs li').nth(5).waitFor();
  check('envia o documento aberto no editor para o Conversor', (await page.locator('.conv-jobs li').count()) === 6);
} catch (e) {
  console.error('ERRO:', e.message.split('\n')[0]);
  await page.screenshot({ path: join(OUT, 'erro.png') });
  results.push(false);
} finally {
  check('sem erros no console', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} verificações passaram.`);
process.exit(failed ? 1 : 0);
