// Roda só no Windows (integração contínua): usa o repositório de certificados real.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { signDigitally } from '../../src/pdf/sign';
import { verifySignatures } from '../../src/pdf/verify';
import { samplePdf } from './helpers';

const require = createRequire(import.meta.url);

describe.runIf(process.platform === 'win32')('certificados do Windows', () => {
  it('lista o certificado de teste e assina com ele via SignedCms', async () => {
    const { listCertificates, signWithCertificate } = require('../../electron/wincert.cjs');
    const certs = await listCertificates();
    const cert = certs.find((c: { commonName: string }) => c.commonName === 'PDF Studio Teste CI');
    expect(cert, JSON.stringify(certs)).toBeDefined();
    const signed = await signDigitally(await samplePdf(1), {
      p12: new Uint8Array(), passphrase: '', page: 0, box: { x: 40, y: 700, w: 220, h: 60 },
      reason: 'CI', location: '', contact: '', imageDataUrl: null,
      external: {
        info: { ...cert, validFrom: new Date(cert.validFrom), validTo: new Date(cert.validTo) },
        sign: (data) => signWithCertificate(cert.thumbprint, data),
      },
    });
    const [r] = await verifySignatures(signed);
    expect(r, JSON.stringify(r)).toMatchObject({ valid: true, signer: 'PDF Studio Teste CI' });
  }, 120_000);
});
