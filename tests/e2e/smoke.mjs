// Teste ponta a ponta no Chromium: abre o app, edita, salva e confere o PDF resultante
// com ferramentas independentes (poppler). Uso: npm run build && npm run test:e2e
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

const OUT = join(process.cwd(), 'test-output');
mkdirSync(OUT, { recursive: true });
const PORT = 4179;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function text(file) {
  return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
}

async function fixtures() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Contrato de prestacao de servicos - pagina ${i}`, { x: 60, y: 760, size: 18, font });
    p.drawText('O valor total sera de R$ 1.000,00 pagos em parcela unica.', { x: 60, y: 720, size: 12, font });
  }
  const form = doc.getForm();
  form.createTextField('nome').addToPage(doc.getPage(0), { x: 60, y: 600, width: 220, height: 22 });
  writeFileSync(join(OUT, 'contrato.pdf'), await doc.save());

  // "Digitalização": página que é só imagem, para o OCR.
  const png = join(OUT, 'scan.png');
  execFileSync('convert', ['-size', '1240x1754', 'xc:white', '-font', 'DejaVu-Sans', '-pointsize', '44', '-fill', 'black',
    '-annotate', '+120+260', 'Relatorio anual de vendas', '-annotate', '+120+360', 'Faturamento aumentou trinta por cento', png]);
  const scan = await PDFDocument.create();
  const img = await scan.embedPng(readFileSync(png));
  scan.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  writeFileSync(join(OUT, 'scan.pdf'), await scan.save());
}

async function main() {
  await fixtures();
  // E2E_DEV=1 testa o servidor de desenvolvimento em vez do build de produção.
  const mode = process.env.E2E_DEV ? [] : ['preview'];
  // E2E_BASE=/pdf-studio/ testa o build publicado num subcaminho (como no GitHub Pages).
  const BASE = process.env.E2E_BASE ?? '/';
  if (BASE !== '/') mode.push('--base', BASE);
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...mode, '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve());
    server.on('exit', () => reject(new Error('servidor encerrou')));
    setTimeout(() => reject(new Error('servidor não iniciou')), 20000);
  });
  const browser = await chromium.launch({ executablePath: existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, locale: 'pt-BR' });
  // Força o caminho de "download" em vez da janela de salvar do sistema.
  await context.addInitScript(() => { delete window.showSaveFilePicker; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());
  page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));

  try {
    await page.goto(`http://localhost:${PORT}${BASE}`);
    await page.screenshot({ path: join(OUT, '01-inicio.png') });

    // Abrir
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Abrir arquivo' }).click();
    await (await chooser).setFiles(join(OUT, 'contrato.pdf'));
    await page.locator('.page[data-page="0"] canvas:not(.loading)').waitFor();
    await page.waitForTimeout(500);
    check('abre o PDF e mostra as 3 páginas', (await page.locator('.page').count()) === 3);
    await page.screenshot({ path: join(OUT, '02-aberto.png') });

    const pageBox = await page.locator('.page[data-page="0"]').boundingBox();
    const at = (x, y) => ({ x: pageBox.x + x * (pageBox.width / 595), y: pageBox.y + y * (pageBox.width / 595) });

    // Adicionar texto
    await page.getByRole('button', { name: 'Adicionar texto' }).click();
    let p = at(60, 300);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.type('Aprovado pela diretoria em 15/10');
    await page.keyboard.press('Escape');

    // Editar texto existente
    await page.getByRole('button', { name: 'Editar texto existente' }).click();
    await page.locator('.page[data-page="0"] .text-target').nth(1).click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('O valor total sera de R$ 2.500,00 em duas parcelas.');
    await page.keyboard.press('Escape');

    // Destacar (arrastar sobre o título)
    await page.getByRole('button', { name: 'Destacar texto' }).click();
    const a = at(55, 70), b = at(300, 90);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    await page.screenshot({ path: join(OUT, 'dbg-destaque.png') });
    check('cria o destaque sobre o texto', (await page.locator('.page[data-page="0"] .markup').count()) >= 1);

    // Retângulo e desenho livre
    await page.getByRole('button', { name: 'Retângulo' }).click();
    let r1 = at(60, 400), r2 = at(250, 480);
    await page.mouse.move(r1.x, r1.y); await page.mouse.down(); await page.mouse.move(r2.x, r2.y, { steps: 4 }); await page.mouse.up();
    await page.getByRole('button', { name: 'Desenho livre' }).click();
    r1 = at(300, 400);
    await page.mouse.move(r1.x, r1.y); await page.mouse.down();
    for (let k = 1; k <= 10; k++) { const q = at(300 + k * 10, 400 + (k % 2) * 20); await page.mouse.move(q.x, q.y); }
    await page.mouse.up();

    // Comentário
    await page.getByRole('button', { name: 'Comentário', exact: true }).click();
    p = at(500, 120);
    await page.mouse.click(p.x, p.y);
    await page.locator('.note-popup textarea').fill('Conferir valor com o financeiro');
    await page.getByRole('button', { name: 'Selecionar' }).click();
    await page.screenshot({ path: join(OUT, '03-editado.png') });

    // Desfazer / refazer
    const before = await page.locator('.overlay .obj').count();
    await page.keyboard.press('Control+Z');
    const afterUndo = await page.locator('.overlay .obj').count();
    await page.keyboard.press('Control+Y');
    const afterRedo = await page.locator('.overlay .obj').count();
    check('desfazer e refazer', afterUndo < before && afterRedo === before, `${before} → ${afterUndo} → ${afterRedo}`);

    // Girar e reordenar página via painel
    await page.locator('.thumb').nth(2).click();
    await page.getByTitle('Girar à direita').click();
    await page.waitForTimeout(800);

    // Formulário
    await page.getByRole('button', { name: 'Formulário', exact: true }).click();
    await page.locator('.form-fields input').first().fill('Maria da Silva');
    await page.getByRole('button', { name: 'Aplicar ao documento' }).click();
    await page.waitForTimeout(800);

    // Salvar
    let dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Salvar' }).click();
    const saved = join(OUT, 'contrato-editado.pdf');
    await (await dl).saveAs(saved);
    const t = text(saved);
    check('texto adicionado foi gravado', t.includes('Aprovado pela diretoria em 15/10'));
    check('texto existente foi substituído', t.includes('R$ 2.500,00 em duas parcelas'));
    check('formulário preenchido', t.includes('Maria da Silva') || execFileSync('pdftotext', [saved, '-']).toString().includes('Maria'));
    check('página 3 girada', /Page\s+3 rot:\s+90/.test(execFileSync('pdfinfo', ['-f', '3', '-l', '3', saved], { encoding: 'utf8' })));
    const savedDoc = await PDFDocument.load(readFileSync(saved));
    const notes = savedDoc.getPage(0).node.Annots()?.asArray().filter((ref) => String(savedDoc.context.lookup(ref).get(PDFName.of('Subtype'))) === '/Text') ?? [];
    check('comentário salvo como anotação PDF', notes.length === 1);

    // Pesquisa
    await page.getByRole('button', { name: 'Pesquisar' }).click();
    await page.locator('.search-form input').fill('prestacao');
    await page.locator('.search-form button').click();
    await page.waitForTimeout(500);
    check('pesquisa encontra o texto nas 3 páginas', (await page.locator('.results li').count()) === 3);

    // Marca d'água pelo hub de ferramentas
    await page.getByRole('button', { name: 'Ferramentas' }).click();
    await page.screenshot({ path: join(OUT, '04-ferramentas.png') });
    await page.locator('.tool-card', { hasText: 'Marca d’água' }).click();
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await page.waitForTimeout(800);

    // Proteger com senha
    await page.getByRole('button', { name: 'Ferramentas' }).click();
    await page.locator('.tool-card', { hasText: 'Proteger com senha' }).click();
    const pw = page.locator('.modal input[type=password]');
    await pw.nth(0).fill('segredo123');
    await pw.nth(1).fill('segredo123');
    await page.getByRole('button', { name: 'Aplicar' }).click();
    dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Salvar' }).click();
    const prot = join(OUT, 'contrato-protegido.pdf');
    await (await dl).saveAs(prot);
    let needsPassword = false;
    try { execFileSync('pdftotext', [prot, '-'], { stdio: 'pipe' }); } catch { needsPassword = true; }
    const withPw = execFileSync('pdftotext', ['-upw', 'segredo123', prot, '-'], { encoding: 'utf8' });
    check('protege com senha (AES)', needsPassword && withPw.replace(/\s/g, '').includes('CONFIDENCIAL'), `pede senha: ${needsPassword}`);

    // Reabrir o arquivo protegido pedindo a senha
    const ch2 = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Abrir' }).first().click();
    await (await ch2).setFiles(prot);
    await page.locator('.modal input[type=password]').fill('segredo123');
    await page.getByRole('button', { name: 'OK' }).click();
    await page.locator('.page[data-page="0"] canvas:not(.loading)').waitFor();
    check('abre PDF protegido com a senha', (await page.locator('.page').count()) === 3);

    // OCR em documento escaneado
    const ch3 = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Abrir' }).first().click();
    await (await ch3).setFiles(join(OUT, 'scan.pdf'));
    await page.locator('.page[data-page="0"] canvas:not(.loading)').waitFor();
    await page.getByRole('button', { name: 'Ferramentas' }).click();
    await page.locator('.tool-card', { hasText: 'Reconhecer texto' }).click();
    await page.getByRole('button', { name: 'Reconhecer texto' }).click();
    await page.locator('.ocr-text').waitFor({ timeout: 180000 });
    const ocrText = await page.locator('.ocr-text').inputValue();
    check('OCR reconhece o texto da imagem', /Relat.rio anual de vendas/i.test(ocrText), JSON.stringify(ocrText.slice(0, 80)));
    await page.getByRole('button', { name: 'Concluir' }).click();
    dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Salvar' }).click();
    const ocrPdf = join(OUT, 'scan-ocr.pdf');
    await (await dl).saveAs(ocrPdf);
    check('PDF com OCR fica pesquisável', /Faturamento/i.test(text(ocrPdf)));

    // Assinatura digital com certificado de teste
    await page.getByRole('button', { name: 'Assinatura digital com certificado' }).click();
    const s1 = at(330, 560), s2 = at(560, 640);
    await page.mouse.move(s1.x, s1.y); await page.mouse.down(); await page.mouse.move(s2.x, s2.y, { steps: 4 }); await page.mouse.up();
    await page.getByRole('button', { name: 'Gerar um certificado de teste' }).click();
    const gen = page.locator('.modal input');
    await gen.nth(0).fill('Joana Teste');
    await gen.nth(2).fill('cert123');
    const certDl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Gerar' }).click();
    await (await certDl).saveAs(join(OUT, 'cert.p12'));
    await page.locator('.cert-info').waitFor({ timeout: 60000 });
    await page.locator('.modal input').nth(1).fill('Aprovação');
    dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Assinar', exact: true }).click();
    const signedPdf = join(OUT, 'scan-assinado.pdf');
    await (await dl).saveAs(signedPdf);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(OUT, '05a-apos-assinar.png') });
    const sig = execFileSync('pdfsig', [signedPdf], { encoding: 'utf8' });
    check('assinatura digital válida (pdfsig)', sig.includes('Joana Teste') && sig.includes('Signature is Valid'));
    await page.getByRole('button', { name: 'Assinaturas' }).click();
    await page.locator('.signatures li.ok').waitFor({ timeout: 10000 });
    check('painel de assinaturas valida no app', (await page.locator('.signatures li.ok').count()) === 1);
    await page.screenshot({ path: join(OUT, '05-assinado.png') });

    // Exportar Word
    await page.getByRole('button', { name: 'Ferramentas' }).click();
    await page.locator('.tool-card', { hasText: 'Exportar para Word' }).click();
    dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar' }).click();
    const docx = join(OUT, 'scan.docx');
    await (await dl).saveAs(docx);
    const docXml = execFileSync('unzip', ['-p', docx, 'word/document.xml'], { encoding: 'utf8' });
    check('exporta para Word com o texto', /Faturamento/i.test(docXml));

    // ---------- Segunda rodada: demais ferramentas ----------
    const open = async (file) => {
      const c = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Abrir' }).first().click();
      await (await c).setFiles(file);
      await page.locator('.page[data-page="0"] canvas:not(.loading)').waitFor();
    };
    const tool = async (name) => {
      await page.getByRole('button', { name: 'Ferramentas' }).click();
      await page.locator('.tool-card', { hasText: name }).click();
    };
    await open(join(OUT, 'contrato.pdf'));

    // Assinatura eletrônica desenhada
    await page.getByRole('button', { name: 'Preencher e assinar (assinatura eletrônica)' }).click();
    const pad = await page.locator('.sig-pad').boundingBox();
    await page.mouse.move(pad.x + 40, pad.y + 60); await page.mouse.down();
    for (let k = 0; k < 20; k++) await page.mouse.move(pad.x + 40 + k * 15, pad.y + 60 + Math.sin(k) * 25);
    await page.mouse.up();
    await page.getByRole('button', { name: 'Usar esta assinatura' }).click();
    const pb = await page.locator('.page[data-page="0"]').boundingBox();
    await page.mouse.click(pb.x + 400, pb.y + 300);
    check('assinatura eletrônica posicionada', (await page.locator('.page[data-page="0"] img.obj').count()) === 1);

    // Numeração de páginas
    await tool('Numeração e rodapé');
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await page.waitForTimeout(500);
    dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Salvar' }).click();
    const numbered = join(OUT, 'contrato-numerado.pdf');
    await (await dl).saveAs(numbered);
    const nt = text(numbered);
    check('numeração de páginas', nt.includes('Página 1 de 3') && nt.includes('Página 3 de 3'));
    const imgs = execFileSync('pdfimages', ['-list', numbered], { encoding: 'utf8' }).split('\n').filter((l) => /^\s+1\s/.test(l));
    check('assinatura eletrônica gravada como imagem', imgs.length >= 1);

    // Combinar com outro arquivo
    await tool('Combinar arquivos');
    const mc = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Adicionar PDFs…' }).click();
    await (await mc).setFiles([join(OUT, 'scan.pdf')]);
    await page.locator('.file-list li').waitFor();
    await page.getByRole('button', { name: 'Combinar e abrir' }).click();
    await page.waitForTimeout(800);
    check('combinar arquivos (3 + 1 páginas)', (await page.locator('.page').count()) === 4);

    // Dividir a cada 2 páginas -> zip com 2 arquivos
    await tool('Dividir');
    await page.locator('.modal input.inline-num').fill('2');
    dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Dividir e baixar (.zip)' }).click();
    const zipPath = join(OUT, 'dividido.zip');
    await (await dl).saveAs(zipPath);
    const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
    check('dividir em arquivos', entries.length === 2, entries.join(', '));

    // Comprimir sem perdas
    await tool('Comprimir');
    await page.getByRole('button', { name: 'Comprimir', exact: true }).click();
    await page.locator('.modal .result').waitFor();
    check('comprimir mostra o resultado', /→/.test(await page.locator('.modal .result').innerText()));
    await page.keyboard.press('Escape');

    // Imagens para PDF
    await tool('Imagens para PDF');
    const ic = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Adicionar imagens' }).click();
    await (await ic).setFiles([join(OUT, 'scan.png'), join(OUT, '01-inicio.png')]);
    await page.locator('.image-grid figure').nth(1).waitFor();
    dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Baixar PDF' }).click();
    const fromImgs = join(OUT, 'imagens.pdf');
    await (await dl).saveAs(fromImgs);
    check('imagens para PDF', /Pages:\s+2/.test(execFileSync('pdfinfo', [fromImgs], { encoding: 'utf8' })));

    // Campos de formulário, link e marcador
    await open(join(OUT, 'contrato.pdf'));
    const fb = await page.locator('.page[data-page="0"]').boundingBox();
    await page.getByRole('button', { name: 'Criar campo de formulário' }).click();
    await page.mouse.click(fb.x + 60, fb.y + 250);
    await page.locator('.properties input').first().fill('cpf');
    await page.getByRole('button', { name: 'Criar campo de formulário' }).click();
    await page.locator('.properties select').selectOption('checkbox');
    await page.mouse.click(fb.x + 60, fb.y + 300);
    await page.getByRole('button', { name: 'Criar link' }).click();
    await page.mouse.move(fb.x + 60, fb.y + 340); await page.mouse.down();
    await page.mouse.move(fb.x + 220, fb.y + 360, { steps: 3 }); await page.mouse.up();
    await page.locator('.properties input[placeholder="https://"]').fill('www.exemplo.com.br');
    await page.getByRole('button', { name: 'Marcadores', exact: true }).click();
    await page.getByRole('button', { name: 'Novo marcador (página atual)' }).click();
    await page.locator('.outline-row').first().waitFor();
    await page.screenshot({ path: join(OUT, '07-campos.png') });
    dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Salvar' }).click();
    const withFields = join(OUT, 'contrato-campos.pdf');
    await (await dl).saveAs(withFields);
    const fdoc = await PDFDocument.load(readFileSync(withFields));
    const fnames = fdoc.getForm().getFields().map((f) => f.getName());
    check('cria campos de formulário', fnames.includes('cpf') && fnames.some((n) => n.startsWith('caixa')), fnames.join(', '));
    const uris = fdoc.getPage(0).node.Annots()?.asArray().map((r) => fdoc.context.lookup(r).lookup(PDFName.of('A'))?.lookup?.(PDFName.of('URI'))?.decodeText?.()).filter(Boolean) ?? [];
    check('cria link', uris.includes('https://www.exemplo.com.br'), uris.join(', '));
    check('cria marcador', fdoc.catalog.lookup(PDFName.of('Outlines')) !== undefined);

    // Exportar Excel e PDF/A
    await open(join(process.cwd(), 'tests', 'fixtures', 'libreoffice-tabela.pdf'));
    await tool('Exportar para Excel');
    dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar', exact: true }).click();
    const xlsx = join(OUT, 'tabela.xlsx');
    await (await dl).saveAs(xlsx);
    execFileSync('soffice', ['--headless', '--convert-to', 'csv', '--outdir', OUT, xlsx], { timeout: 120000 });
    const csv = readFileSync(join(OUT, 'tabela.csv'), 'utf8');
    check('exporta tabela para Excel', csv.includes('Caderno universitário,45,987'), csv.split('\n')[2]);
    await tool('Salvar como PDF/A');
    await page.locator('.modal .result.ok').waitFor();
    dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Gerar PDF/A-2b' }).click();
    const pdfa = join(OUT, 'tabela-pdfa.pdf');
    await (await dl).saveAs(pdfa);
    if (process.env.VERAPDF_LIB) {
      let vr = '';
      try {
        vr = execFileSync('java', ['-cp', `${process.env.VERAPDF_LIB}/*`, 'org.verapdf.apps.GreenfieldCliWrapper', '--format', 'text', pdfa], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) { vr = String(e.stdout ?? e); }
      check('PDF/A aprovado no veraPDF', /^PASS/m.test(vr), vr.split('\n')[0]);
    }

    // Comparar com a versão editada
    await open(join(OUT, 'contrato.pdf'));
    await tool('Comparar arquivos');
    const cc = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Escolher arquivo…' }).click();
    await (await cc).setFiles(join(OUT, 'contrato-editado.pdf'));
    await page.locator('.diff section').first().waitFor();
    const diffText = await page.locator('.diff').innerText();
    check('comparar mostra o valor alterado', diffText.includes('2.500,00') && diffText.includes('1.000,00'));
    await page.screenshot({ path: join(OUT, '06-comparar.png') });
    await page.keyboard.press('Escape');
  } catch (e) {
    await page.screenshot({ path: join(OUT, 'erro.png') });
    console.error('ERRO:', e.message.split('\n').slice(0, 3).join(' '));
    results.push({ name: 'execução sem exceções', ok: false });
  } finally {
    const relevant = errors.filter((e) => !/favicon/i.test(e));
    writeFileSync(join(OUT, 'console-errors.txt'), relevant.join('\n'));
    check('sem erros no console', relevant.length === 0, relevant.slice(0, 5).join(' | '));
    await browser.close();
    server.kill();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram.`);
  process.exit(failed.length ? 1 : 0);
}

main();
