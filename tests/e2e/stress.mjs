// Teste de carga do Conversor no Chromium: arquivos grandes não podem travar nem estourar memória.
// Uso: npm run build && node tests/e2e/stress.mjs arquivo1.pdf [arquivo2.pdf ...]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const files = process.argv.slice(2);
const PORT = 4185;
const LIMIT_MIN = Number(process.env.STRESS_LIMIT_MIN ?? 15);
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes(String(PORT)) && r()));
const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: existsSync(exe) ? exe : undefined, args: ['--enable-precise-memory-info'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
let crashed = false;
page.on('crash', () => (crashed = true));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = 0;

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.getByRole('tab', { name: 'Conversor' }).click();
  for (const f of files) {
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.conv-drop').click();
    await (await chooser).setFiles(f);
    await page.locator('.conv-jobs li').last().waitFor();
    const t0 = Date.now();
    let peak = 0;
    await page.getByRole('button', { name: 'Converter', exact: true }).click();
    const deadline = t0 + LIMIT_MIN * 60_000;
    let status = '';
    while (Date.now() < deadline && !crashed) {
      const s = await page.evaluate(() => ({
        cls: document.querySelector('.conv-jobs li:last-child')?.className ?? '',
        msg: document.querySelector('.conv-jobs li:last-child small')?.textContent ?? '',
        mem: performance.memory?.usedJSHeapSize ?? 0,
        blank: !document.querySelector('.topbar'),
      })).catch(() => ({ cls: '', msg: '', mem: 0, blank: true }));
      peak = Math.max(peak, s.mem);
      if (s.blank) { status = 'TELA EM BRANCO'; break; }
      if (/pronto|erro/.test(s.cls)) { status = s.cls.includes('pronto') ? 'pronto' : `erro: ${s.msg}`; break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (crashed) status = 'PÁGINA TRAVOU (crash)';
    if (!status) status = `NÃO TERMINOU em ${LIMIT_MIN} min`;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const ok = status === 'pronto';
    if (!ok) failed++;
    const info = await page.locator('.conv-jobs li:last-child small').last().innerText().catch(() => '');
    console.log(`${ok ? '✔' : '✘'} ${f.split('/').pop()}: ${status} em ${secs}s · pico de memória JS ${(peak / 1048576).toFixed(0)} MB · ${info}`);
    if (crashed) break;
  }
  if (!crashed) {
    await page.locator('.conv-jobs li').first().click();
    const blank = !(await page.locator('.topbar').count());
    console.log(`${blank ? '✘' : '✔'} interface continua de pé depois da conversão`);
    if (blank) failed++;
  }
} catch (e) {
  console.log('✘ ERRO:', e.message.split('\n')[0]);
  failed++;
} finally {
  if (errors.length) console.log('erros na página:', errors.slice(0, 3).join(' | '));
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
