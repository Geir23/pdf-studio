// Teste do app desktop (Electron). Uso: npm run build && xvfb-run -a npm run test:desktop
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const OUT = join(process.cwd(), 'test-output');
const SAVE_DIR = join(OUT, 'desktop');
rmSync(SAVE_DIR, { recursive: true, force: true });
mkdirSync(SAVE_DIR, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};
for (const f of ['contrato.pdf', 'scan.pdf']) {
  if (!existsSync(join(OUT, f))) throw new Error(`Rode antes o teste ponta a ponta (gera ${f}).`);
}

async function launch(file) {
  const app = await electron.launch({
    // DESKTOP_EXE: testa o app já empacotado (ex.: release/linux-unpacked/pdf-studio).
    executablePath: process.env.DESKTOP_EXE || (await import('electron')).default,
    args: process.env.DESKTOP_EXE ? ['--no-sandbox', file] : ['--no-sandbox', '.', file],
    env: { ...process.env, PDFSTUDIO_SAVE_DIR: SAVE_DIR },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await win.locator('.page[data-page="0"] canvas:not(.loading)').waitFor({ timeout: 30000 });
  return { app, win, errors };
}

const { app, win, errors } = await launch(join(OUT, 'contrato.pdf'));
try {
  check('abre o PDF passado ao programa ("Abrir com")', (await win.locator('.page').count()) === 3);
  check('sem opção de certificado do Windows fora do Windows', !(await win.evaluate(() => window.desktop.platform === 'win32')));
  await win.getByRole('button', { name: 'Adicionar texto' }).click();
  const box = await win.locator('.page[data-page="0"]').boundingBox();
  await win.mouse.click(box.x + 80, box.y + 320);
  await win.keyboard.type('Editado no app desktop – ção');
  await win.keyboard.press('Escape');
  await win.keyboard.press('Control+S');
  await win.locator('.toast.success').first().waitFor();
  const saved = join(SAVE_DIR, 'contrato.pdf');
  const text = existsSync(saved) ? execFileSync('pdftotext', [saved, '-'], { encoding: 'utf8' }) : '';
  check('Ctrl+S grava o arquivo no disco', text.includes('Editado no app desktop – ção'));

  // OCR: workers e WebAssembly servidos pelo protocolo app://
  const chooser = win.waitForEvent('filechooser');
  await win.getByRole('button', { name: 'Abrir' }).first().click();
  await (await chooser).setFiles(join(OUT, 'scan.pdf'));
  await win.locator('.page[data-page="0"] canvas:not(.loading)').waitFor();
  await win.getByRole('button', { name: 'Ferramentas' }).click();
  await win.locator('.tool-card', { hasText: 'Reconhecer texto' }).click();
  await win.getByRole('button', { name: 'Reconhecer texto' }).click();
  await win.locator('.ocr-text').waitFor({ timeout: 180000 });
  check('OCR funciona no desktop', /Relat.rio anual/i.test(await win.locator('.ocr-text').inputValue()));
  await win.screenshot({ path: join(OUT, '08-desktop.png') });
  check('sem erros no console', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.error('ERRO:', e.message.split('\n')[0]);
  await win.screenshot({ path: join(OUT, 'erro-desktop.png') }).catch(() => {});
  results.push(false);
} finally {
  // Encerra sem a pergunta de "alterações não salvas" (o documento ficou modificado).
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} verificações passaram.`);
process.exit(failed ? 1 : 0);
