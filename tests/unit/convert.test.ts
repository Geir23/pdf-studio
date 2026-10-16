import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertInput, type ConvertDeps } from '../../src/convert/convertFile';
import { DEFAULT_OPTIONS, type ConvertOptions } from '../../src/convert/engine';
import { buildFragments, finalizeBlocks, layoutPage } from '../../src/convert/layout';
import { blocksToMarkdown } from '../../src/convert/markdown';
import { render } from '../../src/convert/outputs';
import type { ConvertedDocument, PageData, TextPiece } from '../../src/convert/types';
import { nodePlatform, openFixture } from './convertPlatform';

const FIX = join(__dirname, '..', 'fixtures', 'convert');
const read = (n: string) => new Uint8Array(readFileSync(join(FIX, n)));
const OPTS: ConvertOptions = { ...DEFAULT_OPTIONS, langs: 'por' };

let platform: ReturnType<typeof nodePlatform>;
let deps: ConvertDeps;
const cache = new Map<string, Promise<ConvertedDocument>>();
const convert = (name: string, opts = OPTS) => {
  const key = name + JSON.stringify(opts);
  if (!cache.has(key)) cache.set(key, convertInput({ name, bytes: read(name) }, deps, opts));
  return cache.get(key)!;
};
const md = async (name: string) => blocksToMarkdown((await convert(name)).blocks, { imageDir: 'imagens' });

beforeAll(() => {
  platform = nodePlatform();
  deps = {
    platform,
    openPdf: (b) => openFixture(b) as never,
    toPngOrJpg: async (bytes, name) => ({ bytes, type: name.endsWith('.png') ? 'png' : 'jpg' }),
  };
});
afterAll(async () => platform.close());

describe('PDF com texto', () => {
  it('títulos, parágrafos, negrito/itálico, listas, tabela, link e imagem', async () => {
    const out = await md('relatorio.pdf');
    expect(out).toContain('# Relatório Técnico de Avaliação\n');
    expect(out).toContain('Este documento apresenta a **avaliação completa** do sistema de *gestão integrada*, com base nos indicadores');
    expect(out).toContain('## Objetivos\n\n- Medir a satisfação dos usuários\n- Identificar gargalos operacionais\n- Propor melhorias priorizadas');
    expect(out).toContain('## Etapas\n\n1. Coleta de dados nas unidades\n2. Consolidação e análise estatística');
    expect(out).toContain('| Região | Atendimentos | Satisfação |\n| --- | --- | --- |\n| Sul | 1.250 | 92% |\n| Sudeste | 3.480 | 88% |\n| Nordeste | 2.105 | 85% |');
    expect(out).toContain('[portal oficial](https://exemplo.gov.br/relatorio).');
    expect(out).toContain('![Imagem 1 da página 1](imagens/pagina1-imagem1.png)');
  }, 120_000);

  it('lê o texto de dentro da imagem (OCR) sem transformá-lo em título', async () => {
    const out = await md('relatorio.pdf');
    expect(out).toMatch(/\nVENDAS CRESCERAM 42%\n/);
    expect(out).toContain('Meta anual atingida em outubro');
    expect((await convert('relatorio.pdf')).ocrImages).toBe(1);
  }, 120_000);

  it('remove cabeçalho, rodapé e número de página; respeita duas colunas', async () => {
    const out = await md('relatorio.pdf');
    expect(out).not.toContain('Empresa Exemplo');
    expect(out).not.toMatch(/Página \d/);
    const order = [...out.matchAll(/Bloco (\d+):/g)].map((m) => Number(m[1]));
    expect(order).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect((await convert('relatorio.pdf')).ocrPages).toEqual([]);
  }, 120_000);
});

describe('OCR automático', () => {
  it('PDF escaneado: reconhece e mantém a estrutura (títulos, listas, tabela, colunas)', async () => {
    const doc = await convert('relatorio-escaneado.pdf');
    expect(doc.ocrPages).toEqual([{ page: 0, reason: 'escaneada' }, { page: 1, reason: 'escaneada' }]);
    const out = blocksToMarkdown(doc.blocks, { imageDir: null });
    expect(out).toContain('# Relatório Técnico de Avaliação');
    expect(out).toContain('## Objetivos');
    expect(out).toMatch(/- Identificar gargalos operacionais\n- Propor melhorias priorizadas/);
    expect(out).toContain('1. Coleta de dados nas unidades');
    expect(out).toMatch(/\| Região \| Atendimentos \| Satisfação \|[\s\S]*\| Nordeste \| 2\.105 \| 85% \|/);
    expect(out).not.toContain('Empresa Exemplo');
    expect([...out.matchAll(/Bloco (\d+):/g)].map((m) => Number(m[1]))).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  }, 300_000);

  it('PDF com texto que não dá para copiar: detecta e refaz por OCR, preservando os links', async () => {
    const doc = await convert('relatorio-texto-ilegivel.pdf');
    expect(doc.ocrPages.map((p) => p.reason)).toEqual(['texto-ilegivel', 'texto-ilegivel']);
    const out = blocksToMarkdown(doc.blocks, { imageDir: null });
    expect(out).not.toMatch(/[-]/);
    expect(out).toContain('## Resultados por região');
    expect(out).toContain('[portal oficial](https://exemplo.gov.br/relatorio)');
    expect(out).toMatch(/\nVENDAS CRESCERAM 42%\n/); // texto do gráfico não vira título
  }, 300_000);

  it('imagem (print/foto) vira texto estruturado', async () => {
    const doc = await convert('grafico.png');
    expect(doc.ocrPages.length).toBe(1);
    const out = blocksToMarkdown(doc.blocks, { imageDir: null });
    expect(out).toContain('VENDAS CRESCERAM 42%');
    expect(out).toContain('Meta anual atingida em outubro');
  }, 120_000);

  it('OCR desligado: não reconhece nada', async () => {
    const doc = await convert('relatorio-escaneado.pdf', { ...OPTS, ocr: 'never', images: false });
    expect(doc.ocrPages).toEqual([]);
    expect(blocksToMarkdown(doc.blocks, { imageDir: null }).trim()).toBe('');
  }, 60_000);
});

describe('outras entradas', () => {
  it('Word (.docx) → Markdown com títulos, listas e tabela', async () => {
    const out = await md('relatorio.docx');
    expect(out).toContain('# Relatório Técnico de Avaliação');
    expect(out).toContain('**avaliação completa**');
    expect(out).toMatch(/- Medir a satisfação dos usuários/);
    expect(out).toContain('| Região | Atendimentos | Satisfação |');
    expect(out).toContain('[portal oficial](https://exemplo.gov.br/relatorio)');
  }, 60_000);
});

describe('formatos de saída', () => {
  it('HTML, Word, JSON, texto e ZIP com imagens', async () => {
    const doc = await convert('relatorio.pdf');
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    const html = dec(await render(doc, 'html', 'relatorio'));
    expect(html).toContain('<h1>Relatório Técnico de Avaliação</h1>');
    expect(html).toMatch(/<table>[\s\S]*<td>Nordeste<\/td>/);
    expect(html).toContain('<strong>avaliação completa</strong>');
    expect(html).toContain('src="data:image/png;base64,');

    const zip = await JSZip.loadAsync(await render(doc, 'md-zip', 'relatorio'));
    expect(Object.keys(zip.files).sort()).toEqual(['imagens/', 'imagens/pagina1-imagem1.png', 'relatorio.md']);
    const png = await zip.file('imagens/pagina1-imagem1.png')!.async('uint8array');
    expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');

    const json = JSON.parse(dec(await render(doc, 'json', 'relatorio')));
    expect(json.blocos.find((b: { tipo: string }) => b.tipo === 'tabela').linhas[1]).toEqual(['Sul', '1.250', '92%']);

    const txt = dec(await render(doc, 'txt', 'relatorio'));
    expect(txt).toContain('Sul\t1.250\t92%');
    expect(txt).not.toContain('**');

    const docx = await render(doc, 'docx', 'relatorio');
    const dir = mkdtempSync(join(tmpdir(), 'docx-'));
    writeFileSync(join(dir, 'r.docx'), docx);
    const xml = execFileSync('unzip', ['-p', join(dir, 'r.docx'), 'word/document.xml'], { encoding: 'utf8' });
    expect(xml).toContain('Relatório Técnico de Avaliação');
    expect(xml).toContain('<w:tbl>');
    if (spawnSync('soffice', ['--version']).status === 0) {
      execFileSync('soffice', ['--headless', '--convert-to', 'txt:Text', '--outdir', dir, join(dir, 'r.docx')], { timeout: 120_000 });
      expect(readFileSync(join(dir, 'r.txt'), 'utf8')).toContain('Identificar gargalos operacionais');
    }
  }, 300_000);
});

describe('regras de layout', () => {
  const piece = (str: string, x0: number, baseline: number, size = 11, extra: Partial<TextPiece> = {}): TextPiece => ({
    str, x0, x1: x0 + str.length * size * 0.5, baseline, size, bold: false, italic: false, ...extra,
  });
  const page = (items: TextPiece[]): PageData => ({ index: 0, width: 595, height: 842, items, images: [], links: [] });
  const toMd = (items: TextPiece[]) => blocksToMarkdown(finalizeBlocks(layoutPage(page(items), new Set(), 11)), { imageDir: null });

  it('une palavra hifenizada na quebra de linha, mas mantém "recomenda-se"', () => {
    const out = toMd([
      piece('A implementação foi realizada com exem-', 50, 100),
      piece('plo prático e recomenda-', 50, 113),
      piece('se repetir o teste.', 50, 126),
    ]);
    expect(out.trim()).toBe('A implementação foi realizada com exemplo prático e recomenda-se repetir o teste.');
  });

  it('marcadores de lista de fontes de símbolo (Wingdings) viram lista', () => {
    const out = toMd([piece('', 50, 100), piece('Primeiro item', 70, 100), piece('', 50, 116), piece('Segundo item', 70, 116)]);
    expect(out.trim()).toBe('- Primeiro item\n- Segundo item');
  });

  it('escapa caracteres especiais do Markdown', () => {
    const out = toMd([piece('# não é título: *asterisco* e [colchete]', 50, 100), piece('fim do parágrafo.', 50, 113)]);
    expect(buildFragments(page([piece('a', 1, 1)]).items)).toHaveLength(1);
    expect(out.trim()).toBe('\\# não é título: \\*asterisco\\* e \\[colchete\\] fim do parágrafo.');
  });
});

describe('segurança', () => {
  it('não gera links javascript: vindos do arquivo', async () => {
    const { markdownToBlocks } = await import('../../src/convert/inputs');
    const blocks = markdownToBlocks('[clique](javascript:alert(1)) e [site](https://ok.com) <script>alert(1)</script>');
    const out = blocksToMarkdown(blocks, { imageDir: null });
    expect(out).not.toContain('javascript:');
    expect(out).toContain('[site](https://ok.com)');
    const { marked } = await import('marked');
    const html = marked.parse(out, { async: false }) as string;
    expect(html).not.toMatch(/<script/i); // vira texto: &lt;script&gt;
    expect(html).toContain('&lt;script&gt;');
  });
});
