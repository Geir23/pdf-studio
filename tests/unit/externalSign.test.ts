import { execFileSync } from 'node:child_process';
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { generateTestCertificate, readCertificate, signDigitally } from '../../src/pdf/sign';
import { verifySignatures } from '../../src/pdf/verify';
import { samplePdf, writeTmp } from './helpers';

/** Assinador PKCS#7 destacado independente, no papel do Windows (SignedCms). */
function externalSigner(p12: Uint8Array, pass: string) {
  let bin = '';
  p12.forEach((b) => (bin += String.fromCharCode(b)));
  const pfx = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bin), pass);
  const key = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]![0].key!;
  const cert = pfx.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]![0].cert!;
  return async (data: Uint8Array) => {
    let content = '';
    data.forEach((b) => (content += String.fromCharCode(b)));
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(content);
    p7.addCertificate(cert);
    p7.addSigner({
      key, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.messageDigest },
        { type: forge.pki.oids.signingTime, value: new Date() as unknown as string },
      ],
    });
    p7.sign({ detached: true });
    const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
    return Uint8Array.from(der, (c) => c.charCodeAt(0));
  };
}

describe('assinatura com assinador externo (caminho do Windows/A3)', () => {
  it('gera assinatura válida no poppler e no verificador do app', async () => {
    const p12 = await generateTestCertificate('Token A3 Simulado', '', 'pin');
    const signed = await signDigitally(await samplePdf(1), {
      p12: new Uint8Array(), passphrase: '', page: 0, box: { x: 40, y: 700, w: 220, h: 60 },
      reason: 'Teste', location: '', contact: '', imageDataUrl: null,
      external: { info: readCertificate(p12, 'pin'), sign: externalSigner(p12, 'pin') },
    });
    const report = execFileSync('pdfsig', [writeTmp(signed)], { encoding: 'utf8' });
    expect(report).toContain('Signature is Valid');
    const [r] = await verifySignatures(signed);
    expect(r).toMatchObject({ valid: true, signer: 'Token A3 Simulado' });
  });
});
