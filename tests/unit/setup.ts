import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setFontLoader } from '../../src/pdf/fonts';

// Mesmo comportamento do app: fontes Liberation embutidas no texto novo.
setFontLoader(async (file) => new Uint8Array(await readFile(join(__dirname, '..', '..', 'assets', 'fonts', file))));
