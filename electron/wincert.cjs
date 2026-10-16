// Assinatura com certificados instalados no Windows (A1 importado, token ou cartão A3).
// Usa o PowerShell e a SignedCms do .NET: o próprio Windows pede o PIN do token.
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const LIST_SCRIPT = `
$ErrorActionPreference = 'Stop'
$now = Get-Date
$certs = @(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt $now })
$out = @($certs | ForEach-Object {
  [pscustomobject]@{
    thumbprint = $_.Thumbprint
    commonName = $_.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    email = $_.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::EmailName, $false)
    issuer = $_.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $true)
    validFrom = $_.NotBefore.ToUniversalTime().ToString('o')
    validTo = $_.NotAfter.ToUniversalTime().ToString('o')
    selfSigned = ($_.Subject -eq $_.Issuer)
  }
})
ConvertTo-Json -InputObject $out -Compress
`;

const SIGN_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$cert = Get-Item ('Cert:\\CurrentUser\\My\\' + $env:PDFSTUDIO_THUMB)
$data = [System.IO.File]::ReadAllBytes($env:PDFSTUDIO_IN)
$content = New-Object System.Security.Cryptography.Pkcs.ContentInfo -ArgumentList (,$data)
$cms = New-Object System.Security.Cryptography.Pkcs.SignedCms -ArgumentList $content, $true
$signer = New-Object System.Security.Cryptography.Pkcs.CmsSigner -ArgumentList $cert
$signer.DigestAlgorithm = New-Object System.Security.Cryptography.Oid -ArgumentList '2.16.840.1.101.3.4.2.1'
$signer.IncludeOption = [System.Security.Cryptography.X509Certificates.X509IncludeOption]::WholeChain
[void]$signer.SignedAttributes.Add((New-Object System.Security.Cryptography.Pkcs.Pkcs9SigningTime))
$cms.ComputeSignature($signer, $false)
[System.IO.File]::WriteAllBytes($env:PDFSTUDIO_OUT, $cms.Encode())
`;

function powershell(script, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)),
    );
  });
}

async function listCertificates() {
  if (process.platform !== 'win32') return [];
  const out = (await powershell(LIST_SCRIPT)).trim();
  return out ? JSON.parse(out) : [];
}

/** Assina (PKCS#7 destacado, SHA-256) os bytes com o certificado indicado pela impressão digital. */
async function signWithCertificate(thumbprint, data) {
  if (process.platform !== 'win32') throw new Error('Disponível apenas no Windows.');
  if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint)) throw new Error('Certificado inválido.');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfstudio-'));
  const inFile = path.join(dir, 'conteudo.bin');
  const outFile = path.join(dir, 'assinatura.p7s');
  try {
    await fs.writeFile(inFile, data);
    await powershell(SIGN_SCRIPT, { PDFSTUDIO_THUMB: thumbprint, PDFSTUDIO_IN: inFile, PDFSTUDIO_OUT: outFile });
    return new Uint8Array(await fs.readFile(outFile));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { listCertificates, signWithCertificate };
