import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flattenObjects } from '../../src/pdf/flatten';
import { convertToPdfa, preflightPdfa } from '../../src/pdf/pdfa';
import { samplePdf, writeTmp } from './helpers';

// Validador oficial (veraPDF). Defina VERAPDF_LIB com a pasta dos .jar para rodar a validação.
const VERA = process.env.VERAPDF_LIB;
const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', name)));

function veraPdf(bytes: Uint8Array): { compliant: boolean; report: string } {
  let report = '';
  try {
    report = execFileSync('java', ['-cp', `${VERA}/*`, 'org.verapdf.apps.GreenfieldCliWrapper', '--format', 'text', writeTmp(bytes)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000,
    });
  } catch (e) {
    report = String((e as { stdout?: string }).stdout ?? e);
  }
  return { compliant: /^PASS/m.test(report), report };
}

describe('PDF/A', () => {
  it('aponta fontes não embutidas', async () => {
    const pre = await preflightPdfa(await samplePdf(1));
    expect(pre.missingFonts).toEqual(['Helvetica']);
    expect((await preflightPdfa(fixture('libreoffice-tabela.pdf'))).missingFonts).toEqual([]);
  });

  it.runIf(VERA && existsSync(VERA))('documento editado vira PDF/A-2b válido no veraPDF', async () => {
    const edited = await flattenObjects(fixture('libreoffice-truetype.pdf'), [
      { id: 't', page: 0, kind: 'text', x: 60, y: 200, w: 300, h: 20, text: 'Aprovado – ção', size: 12,
        color: '#c62828', font: 'Helvetica', bold: false, italic: false, bg: null },
      { id: 'h', page: 0, kind: 'highlight', x: 55, y: 25, w: 200, h: 18, color: '#ffeb3b' },
    ]);
    expect(veraPdf(edited).compliant).toBe(false); // antes da conversão
    const result = veraPdf(await convertToPdfa(edited, 'Contrato'));
    expect(result.compliant, result.report).toBe(true);
  }, 300_000);
});
