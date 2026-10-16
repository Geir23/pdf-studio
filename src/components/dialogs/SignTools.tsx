import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { saveDocument } from '../../lib/actions';
import { download } from '../../lib/bytes';
import { imageFileToDataUrl, pickFiles } from '../../lib/files';
import { desktop, type WindowsCertificate } from '../../lib/desktop';
import { generateTestCertificate, readCertificate, signDigitally, type CertInfo, type DigitalSignOptions } from '../../pdf/sign';
import { useStore } from '../../store';
import { Check, Field, Modal } from '../ui';
import { close } from './common';

const SAVED_KEY = 'pdfstudio.signatures';

function loadSaved(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function storeSaved(list: string[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 6)));
  } catch {
    /* armazenamento cheio ou bloqueado */
  }
}

/** Recorta as bordas transparentes e devolve PNG + proporção. */
function trimCanvas(src: HTMLCanvasElement): { dataUrl: string; ratio: number } | null {
  const ctx = src.getContext('2d')!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL('image/png'), ratio: out.width / out.height };
}

function ratioOf(dataUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth / img.naturalHeight || 3);
    img.onerror = () => resolve(3);
    img.src = dataUrl;
  });
}

const TYPE_FONTS = [
  { label: 'Cursiva', css: '"Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive' },
  { label: 'Elegante', css: 'italic 400 1em "Palatino Linotype", "Book Antiqua", Georgia, serif' },
  { label: 'Simples', css: 'italic 400 1em "Segoe UI", Helvetica, Arial, sans-serif' },
];

export function SignatureDialog() {
  const [tab, setTab] = useState<'draw' | 'type' | 'image'>('draw');
  const [saved, setSaved] = useState<string[]>(loadSaved);
  const [remember, setRemember] = useState(true);
  const [color, setColor] = useState('#0d2a6b');
  const [name, setName] = useState('');
  const [fontIdx, setFontIdx] = useState(0);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [removeBg, setRemoveBg] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  const s = useStore.getState;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (tab === 'type' && name.trim()) {
      const f = TYPE_FONTS[fontIdx].css;
      ctx.fillStyle = color;
      ctx.font = f.includes('1em') ? f.replace('1em', '72px') : `72px ${f}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(name, c.width / 2, c.height / 2, c.width - 20);
    }
    setEmpty(tab !== 'type' || !name.trim());
  }, [tab, name, fontIdx, color]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * e.currentTarget.width, ((e.clientY - r.top) / r.height) * e.currentTarget.height] as const;
  };

  const use = async (sig: { dataUrl: string; ratio: number }) => {
    if (remember && !saved.includes(sig.dataUrl)) storeSaved([sig.dataUrl, ...saved]);
    s().setPendingSignature(sig);
    s().toast('Clique na página onde a assinatura deve ficar.');
    close();
  };

  const confirm = async () => {
    if (tab === 'image') {
      if (!uploaded) return s().toast('Escolha uma imagem.', 'error');
      return use({ dataUrl: uploaded, ratio: await ratioOf(uploaded) });
    }
    const t = trimCanvas(canvas.current!);
    if (!t) return s().toast(tab === 'draw' ? 'Desenhe sua assinatura no quadro.' : 'Digite seu nome.', 'error');
    return use(t);
  };

  const loadImage = async () => {
    const [file] = await pickFiles('image/*');
    if (!file) return;
    const { dataUrl } = await imageFileToDataUrl(file);
    if (!removeBg) return setUploaded(dataUrl);
    // Torna o fundo claro transparente (assinatura fotografada/escaneada em papel branco).
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const lum = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
      if (lum > 200) d.data[i + 3] = 0;
      else if (lum > 150) d.data[i + 3] = Math.round(((200 - lum) / 50) * 255);
    }
    ctx.putImageData(d, 0, 0);
    setUploaded(trimCanvas(c)?.dataUrl ?? c.toDataURL('image/png'));
  };

  return (
    <Modal title="Preencher e assinar" onClose={close} wide footer={<button className="primary" onClick={confirm}>Usar esta assinatura</button>}>
      {saved.length > 0 && (
        <>
          <h4>Assinaturas salvas</h4>
          <div className="saved-sigs">
            {saved.map((d, i) => (
              <div key={i} className="saved-sig">
                <button onClick={async () => use({ dataUrl: d, ratio: await ratioOf(d) })} title="Usar"><img src={d} alt="Assinatura salva" /></button>
                <button className="icon" title="Apagar" onClick={() => { const next = saved.filter((_, k) => k !== i); storeSaved(next); setSaved(next); }}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <h4>Nova assinatura</h4>
        </>
      )}
      <div className="segmented">
        <button className={tab === 'draw' ? 'active' : ''} onClick={() => setTab('draw')}>Desenhar</button>
        <button className={tab === 'type' ? 'active' : ''} onClick={() => setTab('type')}>Digitar</button>
        <button className={tab === 'image' ? 'active' : ''} onClick={() => setTab('image')}>Imagem</button>
      </div>
      {tab === 'type' && (
        <div className="row">
          <input placeholder="Seu nome" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <select value={fontIdx} onChange={(e) => setFontIdx(Number(e.target.value))}>
            {TYPE_FONTS.map((f, i) => <option key={i} value={i}>{f.label}</option>)}
          </select>
        </div>
      )}
      {tab !== 'image' ? (
        <>
          <canvas
            ref={canvas}
            width={900}
            height={260}
            className={`sig-pad ${tab === 'draw' ? 'drawable' : ''}`}
            onPointerDown={(e) => {
              if (tab !== 'draw') return;
              drawing.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              const ctx = e.currentTarget.getContext('2d')!;
              const [x, y] = point(e);
              ctx.strokeStyle = color;
              ctx.lineWidth = 5;
              ctx.lineCap = 'round';
              ctx.lineJoin = 'round';
              ctx.beginPath();
              ctx.moveTo(x, y);
              ctx.lineTo(x + 0.1, y + 0.1);
              ctx.stroke();
              setEmpty(false);
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return;
              const ctx = e.currentTarget.getContext('2d')!;
              const [x, y] = point(e);
              ctx.lineTo(x, y);
              ctx.stroke();
            }}
            onPointerUp={() => (drawing.current = false)}
          />
          <div className="row">
            <span>Cor:</span>
            {['#0d2a6b', '#000000', '#1565c0'].map((c) => (
              <button key={c} className={`swatch ${color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Cor ${c}`} />
            ))}
            {tab === 'draw' && !empty && <button onClick={() => { const c = canvas.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); setEmpty(true); }}>Limpar</button>}
          </div>
        </>
      ) : (
        <>
          <Check label="Remover fundo branco (foto de assinatura no papel)" checked={removeBg} onChange={setRemoveBg} />
          <button onClick={loadImage}>Escolher imagem…</button>
          {uploaded && <img className="sig-preview" src={uploaded} alt="Pré-visualização" />}
        </>
      )}
      <Check label="Salvar esta assinatura neste navegador" checked={remember} onChange={setRemember} />
      <p className="hint">A assinatura eletrônica é uma imagem aplicada ao documento. Para validade com certificado (ex.: ICP-Brasil), use a Assinatura digital.</p>
    </Modal>
  );
}

export function DigitalSignDialog() {
  const pending = useStore((s) => s.pendingDigitalBox);
  const currentPage = useStore((s) => s.currentPage);
  const security = useStore((s) => s.security);
  const [p12, setP12] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [pass, setPass] = useState('');
  const [info, setInfo] = useState<CertInfo | null>(null);
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [contact, setContact] = useState('');
  const [useImage, setUseImage] = useState(false);
  const [gen, setGen] = useState<{ name: string; email: string; pass: string } | null>(null);
  const onWindows = desktop?.platform === 'win32';
  const [source, setSource] = useState<'file' | 'windows'>(onWindows ? 'windows' : 'file');
  const [winCerts, setWinCerts] = useState<WindowsCertificate[] | null>(null);
  const [thumb, setThumb] = useState('');
  const saved = loadSaved();

  useEffect(() => {
    if (source !== 'windows' || winCerts) return;
    desktop!.listCertificates()
      .then((list) => {
        setWinCerts(list);
        if (list[0]) setThumb(list[0].thumbprint);
      })
      .catch((e) => {
        setWinCerts([]);
        s().toast(`Não foi possível ler os certificados do Windows: ${(e as Error).message}`, 'error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);
  const s = useStore.getState;

  const cancel = () => {
    s().setPendingDigitalBox(null);
    s().setTool('select');
    close();
  };

  const check = () => {
    if (!p12) return null;
    try {
      const i = readCertificate(p12.bytes, pass);
      setInfo(i);
      return i;
    } catch (e) {
      setInfo(null);
      s().toast((e as Error).message, 'error');
      return null;
    }
  };

  const sign = async () => {
    if (security) return s().toast('Remova a proteção por senha antes de assinar (Ferramentas › Proteger). A proteção regravaria o arquivo e invalidaria a assinatura.', 'error');
    let external: DigitalSignOptions['external'];
    if (source === 'windows') {
      const cert = winCerts?.find((c) => c.thumbprint === thumb);
      if (!cert) return s().toast('Escolha um certificado.', 'error');
      external = {
        info: { ...cert, validFrom: new Date(cert.validFrom), validTo: new Date(cert.validTo) },
        sign: (data) => desktop!.signWithCertificate(cert.thumbprint, data),
      };
    } else {
      if (!p12) return s().toast('Escolha o arquivo do certificado (.pfx ou .p12).', 'error');
      if (!check()) return;
    }
    const ok = await s().run(source === 'windows' ? 'Assinando… (o Windows pode pedir o PIN do token)' : 'Assinando…', () =>
      s().apply('Assinatura digital', (b) =>
        signDigitally(b, {
          p12: p12?.bytes ?? new Uint8Array(), passphrase: pass, page: pending?.page ?? currentPage, box: pending?.box ?? null,
          reason, location, contact, imageDataUrl: useImage && saved[0] ? saved[0] : null, external,
        }), { allowOnSigned: true }),
    );
    if (!ok) return;
    useStore.setState({ signed: true });
    s().setPendingDigitalBox(null);
    s().setTool('select');
    close();
    s().toast('Documento assinado. Salve agora — qualquer alteração posterior invalida a assinatura.', 'success');
    await saveDocument();
  };

  const generate = () =>
    s().run('Gerando certificado de teste (pode levar alguns segundos)…', async () => {
      if (!gen?.name.trim() || !gen.pass) throw new Error('Informe nome e senha.');
      const bytes = await generateTestCertificate(gen.name.trim(), gen.email.trim(), gen.pass);
      download(new Blob([bytes as BlobPart], { type: 'application/x-pkcs12' }), `certificado-teste-${gen.name.trim().replace(/\s+/g, '-')}.p12`);
      setP12({ name: 'certificado de teste', bytes });
      setPass(gen.pass);
      setInfo(readCertificate(bytes, gen.pass));
      setGen(null);
    });

  if (gen) {
    return (
      <Modal title="Certificado de teste" onClose={() => setGen(null)} footer={<button className="primary" onClick={generate}>Gerar</button>}>
        <p className="warn">Certificados autoassinados servem para testes e uso interno. Eles não têm validade jurídica como os certificados ICP-Brasil.</p>
        <Field label="Nome do titular"><input value={gen.name} onChange={(e) => setGen({ ...gen, name: e.target.value })} /></Field>
        <Field label="E-mail (opcional)"><input value={gen.email} onChange={(e) => setGen({ ...gen, email: e.target.value })} /></Field>
        <Field label="Senha para proteger o certificado"><input type="password" value={gen.pass} onChange={(e) => setGen({ ...gen, pass: e.target.value })} /></Field>
      </Modal>
    );
  }

  return (
    <Modal title="Assinatura digital" onClose={cancel} footer={<><button onClick={cancel}>Cancelar</button><button className="primary" onClick={sign}>Assinar</button></>}>
      <p className="hint">
        Assina com certificado digital{onWindows ? ' (instalado no Windows ou arquivo .pfx)' : ' A1 (arquivo .pfx/.p12)'}, no padrão PKCS#7 (adbe.pkcs7.detached), reconhecido pelo Adobe Reader.
        {pending ? ` A assinatura aparecerá na página ${pending.page + 1}.` : ' Sem área desenhada: a assinatura será invisível.'}
      </p>
      {onWindows && (
        <div className="segmented">
          <button className={source === 'windows' ? 'active' : ''} onClick={() => setSource('windows')}>Instalado no Windows (A1 ou token A3)</button>
          <button className={source === 'file' ? 'active' : ''} onClick={() => setSource('file')}>Arquivo .pfx</button>
        </div>
      )}
      {source === 'windows' ? (
        <Field label="Certificado" hint="Certificados com chave privada no repositório pessoal do Windows. Tokens e cartões A3 aparecem aqui com o leitor conectado.">
          {winCerts === null ? <span className="hint">Lendo certificados…</span> : winCerts.length === 0 ? (
            <span className="warn">Nenhum certificado válido encontrado. Conecte o token/cartão e reabra esta janela.</span>
          ) : (
            <select value={thumb} onChange={(e) => setThumb(e.target.value)}>
              {winCerts.map((c) => (
                <option key={c.thumbprint} value={c.thumbprint}>
                  {c.commonName} — {c.issuer || 'emissor desconhecido'} (até {new Date(c.validTo).toLocaleDateString('pt-BR')})
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : (
        <>
      <Field label="Certificado">
        <div className="row">
          <button onClick={async () => {
            const [f] = await pickFiles('.pfx,.p12,application/x-pkcs12');
            if (f) { setP12({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }); setInfo(null); }
          }}>Escolher arquivo…</button>
          <span className="name">{p12?.name ?? 'nenhum'}</span>
        </div>
        </Field>
        <Field label="Senha do certificado">
        <input type="password" value={pass} onChange={(e) => { setPass(e.target.value); setInfo(null); }} onBlur={() => p12 && pass && check()} />
        </Field>
        {info && (
        <div className="cert-info">
          <strong>{info.commonName}</strong>
          <small>Emitido por: {info.issuer || '—'}{info.selfSigned ? ' (autoassinado)' : ''}</small>
          <small>Válido até {info.validTo.toLocaleDateString('pt-BR')}{info.validTo < new Date() ? ' — VENCIDO' : ''}</small>
        </div>
      )}
        </>
      )}
      <div className="grid2">
        <Field label="Motivo"><input value={reason} placeholder="Ex.: Aprovo este documento" onChange={(e) => setReason(e.target.value)} /></Field>
        <Field label="Local"><input value={location} placeholder="Ex.: São Paulo, SP" onChange={(e) => setLocation(e.target.value)} /></Field>
      </div>
      <Field label="Contato (opcional)"><input value={contact} onChange={(e) => setContact(e.target.value)} /></Field>
      {pending && saved[0] && <Check label="Incluir minha assinatura manuscrita salva na aparência" checked={useImage} onChange={setUseImage} />}
      <p className="hint">
        Não tem certificado? <button className="link" onClick={() => setGen({ name: '', email: '', pass: '' })}>Gerar um certificado de teste</button>.
        {!desktop && 'Certificados A3 (token/cartão) funcionam na versão desktop para Windows.'}
      </p>
    </Modal>
  );
}
