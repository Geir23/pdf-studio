import forge from 'node-forge';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFSignature, PDFString } from 'pdf-lib';

export interface SignatureReport {
  fieldName: string;
  signer: string;
  issuer: string;
  selfSigned: boolean;
  reason: string;
  signingTime: Date | null;
  valid: boolean;
  coversWholeDocument: boolean;
  error?: string;
}

const asn1 = forge.asn1;

const DIGESTS: Record<string, () => forge.md.MessageDigest> = {
  [forge.pki.oids.sha1]: () => forge.md.sha1.create(),
  [forge.pki.oids.sha256]: () => forge.md.sha256.create(),
  [forge.pki.oids.sha384]: () => forge.md.sha384.create(),
  [forge.pki.oids.sha512]: () => forge.md.sha512.create(),
};

const HASH_NAMES: Record<string, string> = {
  [forge.pki.oids.sha1]: 'SHA-1',
  [forge.pki.oids.sha256]: 'SHA-256',
  [forge.pki.oids.sha384]: 'SHA-384',
  [forge.pki.oids.sha512]: 'SHA-512',
};

function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function text(dict: PDFDict, key: string): string {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
}

function toBinary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

/** Verifica a integridade criptográfica das assinaturas digitais (PKCS#7 destacado). */
export async function verifySignatures(bytes: Uint8Array): Promise<SignatureReport[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const reports: SignatureReport[] = [];
  for (const field of doc.getForm().getFields()) {
    if (!(field instanceof PDFSignature)) continue;
    const v = field.acroField.dict.lookupMaybe(PDFName.of('V'), PDFDict);
    if (!v) continue; // campo de assinatura vazio
    const report: SignatureReport = {
      fieldName: field.getName(),
      signer: text(v, 'Name'),
      issuer: '',
      selfSigned: false,
      reason: text(v, 'Reason'),
      signingTime: null,
      valid: false,
      coversWholeDocument: false,
    };
    try {
      const m = v.lookup(PDFName.of('M'));
      if (m instanceof PDFString || m instanceof PDFHexString) report.signingTime = m.decodeDate();
    } catch {
      /* data em formato não padrão */
    }
    try {
      await verifyOne(bytes, v, report);
    } catch (e) {
      report.valid = false;
      report.error = e instanceof Error ? e.message : String(e);
    }
    reports.push(report);
  }
  return reports;
}

async function verifyOne(bytes: Uint8Array, v: PDFDict, report: SignatureReport) {
  const br = v.lookup(PDFName.of('ByteRange'), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
  const contents = v.lookup(PDFName.of('Contents'));
  if (br.length !== 4 || !(contents instanceof PDFHexString || contents instanceof PDFString)) {
    throw new Error('Estrutura de assinatura não reconhecida.');
  }
  const [a, b, c, d] = br;
  const signed = new Uint8Array(b + d);
  signed.set(bytes.subarray(a, a + b), 0);
  signed.set(bytes.subarray(c, c + d), b);
  report.coversWholeDocument = c + d >= bytes.length - 2;

  const der = toBinary(contents.asBytes());
  const p7asn1 = asn1.fromDer(der, { parseAllBytes: false } as never);
  const msg = forge.pkcs7.messageFromAsn1(p7asn1) as forge.pkcs7.PkcsSignedData & {
    rawCapture: { signerInfos?: forge.asn1.Asn1[] };
  };
  const signerInfo = msg.rawCapture.signerInfos?.[0];
  if (!signerInfo) throw new Error('Assinatura sem informações do signatário.');
  const parts = signerInfo.value as forge.asn1.Asn1[];
  const digestOid = asn1.derToOid((parts[2].value as forge.asn1.Asn1[])[0].value as string);
  const authAttrs = parts.find((p) => p.tagClass === asn1.Class.CONTEXT_SPECIFIC && p.type === 0);
  const sigNode = parts.find((p) => p.tagClass === asn1.Class.UNIVERSAL && p.type === asn1.Type.OCTETSTRING);
  const makeDigest = DIGESTS[digestOid];
  if (!makeDigest) throw new Error('Algoritmo de resumo não suportado na verificação.');
  if (!authAttrs || !sigNode) throw new Error('Assinatura sem atributos autenticados.');

  // 1) O resumo do conteúdo assinado precisa bater com o atributo messageDigest.
  const md = makeDigest();
  md.update(toBinary(signed));
  const contentDigest = md.digest().getBytes();
  let messageDigest: string | null = null;
  for (const attr of authAttrs.value as forge.asn1.Asn1[]) {
    const [oid, set] = attr.value as forge.asn1.Asn1[];
    if (asn1.derToOid(oid.value as string) === forge.pki.oids.messageDigest) {
      messageDigest = (set.value as forge.asn1.Asn1[])[0].value as string;
    }
  }
  if (messageDigest !== contentDigest) {
    throw new Error('O documento foi alterado depois de assinado (resumo não confere).');
  }

  // 2) A assinatura sobre os atributos precisa ser válida para a chave do certificado.
  const attrsSet = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, authAttrs.value as forge.asn1.Asn1[]);
  const attrsDer = binaryToBytes(asn1.toDer(attrsSet).getBytes());
  const signature = binaryToBytes(sigNode.value as string);
  const hash = HASH_NAMES[digestOid];
  // Verificação RSA pela Web Crypto do navegador/Node: a do node-forge aceita
  // assinaturas malformadas (GHSA-86w9-cpqp-85rv).
  let cert: forge.pki.Certificate | undefined;
  for (const crt of msg.certificates) {
    try {
      const spki = binaryToBytes(asn1.toDer(forge.pki.publicKeyToAsn1(crt.publicKey)).getBytes());
      const key = await crypto.subtle.importKey('spki', spki as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
      if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, attrsDer as BufferSource)) {
        cert = crt;
        break;
      }
    } catch {
      /* chave não RSA ou certificado ilegível */
    }
  }
  if (!cert) throw new Error('A assinatura não confere com o certificado (ou usa algoritmo não suportado).');
  const cn = (n: forge.pki.Certificate['subject']) => (n.getField('CN')?.value as string | undefined) ?? '';
  report.signer = cn(cert.subject) || report.signer;
  report.issuer = cn(cert.issuer) || ((cert.issuer.getField('O')?.value as string | undefined) ?? '');
  report.selfSigned = cert.subject.hash === cert.issuer.hash;
  report.valid = true;
}
