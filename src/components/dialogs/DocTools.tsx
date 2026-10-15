import { useEffect, useState } from 'react';
import { ocrDocument } from '../../pdf/ocr';
import { openPdf } from '../../pdf/pdfjs';
import { rasterizePages } from '../../pdf/render';
import {
  addHeaderFooter, addWatermark, getMetadata, optimizeLossless, setMetadata,
  type Metadata, type ProtectOptions, type Slot,
} from '../../pdf/tools';
import type { FontFamily } from '../../pdf/types';
import { useStore } from '../../store';
import { Check, ColorInput, Field, Modal } from '../ui';
import { PagesField, close, formatSize, resolvePages } from './common';

export function OcrDialog() {
  const n = useStore((s) => s.pageSizes.length);
  const [langs, setLangs] = useState('por+eng');
  const [pages, setPages] = useState('');
  const [skip, setSkip] = useState(true);
  const [dpi, setDpi] = useState(250);
  const [text, setText] = useState<string | null>(null);
  const s = useStore.getState;

  const run = async () => {
    const idx = resolvePages(pages, n);
    let recognized: string[] = [];
    let summary = '';
    await s().run('Preparando OCR…', () =>
      s().apply('Reconhecer texto (OCR)', async (bytes) => {
        const view = await openPdf(bytes);
        try {
          const r = await ocrDocument(bytes, view, {
            langs, pages: idx, skipPagesWithText: skip, dpi,
            onProgress: (msg, f) => s().setBusy(msg, f),
          });
          recognized = r.text;
          summary = `${r.processed.length} página(s) reconhecida(s)` + (r.skipped.length ? `, ${r.skipped.length} já tinham texto e foram puladas` : '');
          return r.bytes;
        } finally {
          void view.loadingTask.destroy();
        }
      }),
    );
    if (summary) {
      s().toast(`OCR concluído: ${summary}. O texto agora pode ser pesquisado e copiado.`, 'success');
      setText(recognized.join('\n\n'));
    }
  };

  if (text !== null) {
    return (
      <Modal title="Texto reconhecido" onClose={close} wide
        footer={<>
          <button onClick={() => navigator.clipboard.writeText(text).then(() => s().toast('Texto copiado.', 'success'))}>Copiar texto</button>
          <button className="primary" onClick={close}>Concluir</button>
        </>}>
        <p className="hint">O texto foi gravado como camada invisível no PDF: o documento agora é pesquisável e o texto pode ser selecionado.</p>
        <textarea className="ocr-text" readOnly value={text || '(nenhum texto encontrado nas páginas processadas)'} />
      </Modal>
    );
  }

  return (
    <Modal title="Reconhecer texto (OCR)" onClose={close} footer={<button className="primary" onClick={run}>Reconhecer texto</button>}>
      <p className="hint">Transforma páginas escaneadas ou fotos em texto pesquisável e selecionável. Tudo roda no seu computador; nada é enviado para a internet.</p>
      <Field label="Idioma do documento">
        <select value={langs} onChange={(e) => setLangs(e.target.value)}>
          <option value="por+eng">Português + Inglês</option>
          <option value="por">Português</option>
          <option value="eng">Inglês</option>
        </select>
      </Field>
      <Field label="Qualidade">
        <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
          <option value={200}>Rápida (200 dpi)</option>
          <option value={250}>Normal (250 dpi)</option>
          <option value={300}>Alta, para letras pequenas (300 dpi)</option>
        </select>
      </Field>
      <PagesField value={pages} onChange={setPages} />
      <Check label="Pular páginas que já têm texto" checked={skip} onChange={setSkip} />
    </Modal>
  );
}

const COMPRESS = {
  lossless: { label: 'Sem perda de qualidade', hint: 'Reorganiza a estrutura do arquivo. Mantém texto e imagens intactos; a redução costuma ser pequena.' },
  medium: { label: 'Média (150 dpi)', hint: 'Converte as páginas em imagem JPEG. Grande redução para documentos escaneados; o texto deixa de ser selecionável (rode o OCR depois, se precisar).' },
  strong: { label: 'Forte (100 dpi)', hint: 'Redução máxima, com perda visível de nitidez. O texto deixa de ser selecionável.' },
} as const;

export function CompressDialog() {
  const bytes = useStore((s) => s.bytes);
  const n = useStore((s) => s.pageSizes.length);
  const [mode, setMode] = useState<keyof typeof COMPRESS>('lossless');
  const [result, setResult] = useState<{ mode: string; bytes: Uint8Array; before: number } | null>(null);
  const s = useStore.getState;

  const run = () =>
    s().run('Comprimindo…', async () => {
      const baked = await s().bake();
      let out: Uint8Array;
      if (mode === 'lossless') {
        out = await optimizeLossless(baked);
      } else {
        const view = await openPdf(baked);
        try {
          out = await rasterizePages(baked, view, Array.from({ length: n }, (_, i) => i), {
            dpi: mode === 'medium' ? 150 : 100,
            quality: mode === 'medium' ? 0.7 : 0.5,
            onProgress: (d, t) => s().setBusy(`Comprimindo página ${d} de ${t}…`, d / t),
          });
        } finally {
          void view.loadingTask.destroy();
        }
      }
      setResult({ mode, bytes: out, before: baked.length });
    });

  const apply = () =>
    s().run('Aplicando…', async () => {
      await s().apply('Comprimir', async () => result!.bytes);
      close();
    });

  const pct = result ? Math.round((1 - result.bytes.length / result.before) * 100) : 0;
  return (
    <Modal title="Comprimir PDF" onClose={close}
      footer={result && result.mode === mode
        ? <><button onClick={() => setResult(null)}>Voltar</button><button className="primary" onClick={apply} disabled={pct <= 0}>Usar versão comprimida</button></>
        : <button className="primary" onClick={run}>Comprimir</button>}>
      <p className="hint">Tamanho atual: {bytes ? formatSize(bytes.length) : '—'}</p>
      {(Object.keys(COMPRESS) as (keyof typeof COMPRESS)[]).map((k) => (
        <label key={k} className="radio block">
          <input type="radio" checked={mode === k} onChange={() => setMode(k)} />
          <span><strong>{COMPRESS[k].label}</strong><small>{COMPRESS[k].hint}</small></span>
        </label>
      ))}
      {result && result.mode === mode && (
        <p className={`result ${pct > 0 ? 'ok' : ''}`}>
          {formatSize(result.before)} → {formatSize(result.bytes.length)}{' '}
          {pct > 0 ? `(${pct}% menor)` : '— não houve redução; o arquivo já está otimizado para este modo.'}
        </p>
      )}
    </Modal>
  );
}

export function ProtectDialog() {
  const security = useStore((s) => s.security);
  const signed = useStore((s) => s.signed);
  const [o, setO] = useState<ProtectOptions>(
    security ?? { userPassword: '', ownerPassword: '', allowPrinting: true, allowCopying: false, allowModifying: false, allowAnnotating: true, allowFillingForms: true },
  );
  const [confirm, setConfirm] = useState(security?.userPassword ?? '');
  const s = useStore.getState;
  const save = () => {
    if (!o.userPassword && !o.ownerPassword) return s().toast('Defina ao menos uma senha.', 'error');
    if (o.userPassword !== confirm) return s().toast('As senhas de abertura não conferem.', 'error');
    s().setSecurity(o);
    s().toast('Proteção configurada. Ela será aplicada quando você salvar o documento.', 'success');
    close();
  };
  return (
    <Modal title="Proteger com senha" onClose={close}
      footer={<>
        {security && <button className="danger" onClick={() => { s().setSecurity(null); s().toast('A proteção será removida ao salvar.'); close(); }}>Remover proteção</button>}
        <button className="primary" onClick={save}>Aplicar</button>
      </>}>
      {signed && <p className="warn">Proteger um documento assinado digitalmente regrava o arquivo e invalida as assinaturas.</p>}
      <p className="hint">Criptografia AES-256. Guarde a senha: sem ela não há como abrir o arquivo.</p>
      <Field label="Senha para abrir o documento" hint="Deixe em branco para permitir abrir sem senha e só restringir permissões.">
        <input type="password" autoComplete="new-password" value={o.userPassword} onChange={(e) => setO({ ...o, userPassword: e.target.value })} />
      </Field>
      <Field label="Confirme a senha de abertura">
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <Field label="Senha de permissões (proprietário)" hint="Necessária para alterar as restrições abaixo em outros leitores.">
        <input type="password" autoComplete="new-password" value={o.ownerPassword} onChange={(e) => setO({ ...o, ownerPassword: e.target.value })} />
      </Field>
      <fieldset>
        <legend>Permitir</legend>
        <Check label="Imprimir" checked={o.allowPrinting} onChange={(v) => setO({ ...o, allowPrinting: v })} />
        <Check label="Copiar texto e imagens" checked={o.allowCopying} onChange={(v) => setO({ ...o, allowCopying: v })} />
        <Check label="Modificar o documento" checked={o.allowModifying} onChange={(v) => setO({ ...o, allowModifying: v })} />
        <Check label="Comentar" checked={o.allowAnnotating} onChange={(v) => setO({ ...o, allowAnnotating: v })} />
        <Check label="Preencher formulários" checked={o.allowFillingForms} onChange={(v) => setO({ ...o, allowFillingForms: v })} />
      </fieldset>
    </Modal>
  );
}

export function WatermarkDialog() {
  const n = useStore((s) => s.pageSizes.length);
  const [text, setText] = useState('CONFIDENCIAL');
  const [size, setSize] = useState(60);
  const [color, setColor] = useState('#d32f2f');
  const [opacity, setOpacity] = useState(0.25);
  const [angle, setAngle] = useState(45);
  const [font, setFont] = useState<FontFamily>('Helvetica');
  const [pages, setPages] = useState('');
  const s = useStore.getState;
  const run = () =>
    s().run('Aplicando marca d’água…', async () => {
      const idx = resolvePages(pages, n);
      await s().apply('Marca d’água', (b) => addWatermark(b, { text, size, color, opacity, angle, font, bold: true, pages: idx }));
      close();
    });
  return (
    <Modal title="Marca d’água" onClose={close} footer={<button className="primary" onClick={run} disabled={!text.trim()}>Aplicar</button>}>
      <Field label="Texto"><input value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <div className="grid2">
        <Field label="Fonte">
          <select value={font} onChange={(e) => setFont(e.target.value as FontFamily)}>
            <option value="Helvetica">Helvetica</option><option value="Times">Times</option><option value="Courier">Courier</option>
          </select>
        </Field>
        <Field label="Tamanho"><input type="number" min={8} max={300} value={size} onChange={(e) => setSize(Number(e.target.value))} /></Field>
        <Field label={`Opacidade: ${Math.round(opacity * 100)}%`}><input type="range" min={0.05} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></Field>
        <Field label={`Ângulo: ${angle}°`}><input type="range" min={-90} max={90} step={5} value={angle} onChange={(e) => setAngle(Number(e.target.value))} /></Field>
        <Field label="Cor"><ColorInput value={color} onChange={setColor} /></Field>
      </div>
      <div className="wm-preview" style={{ color, opacity, transform: `rotate(${-angle}deg)`, fontFamily: font === 'Times' ? 'serif' : font === 'Courier' ? 'monospace' : 'sans-serif' }}>{text}</div>
      <PagesField value={pages} onChange={setPages} />
    </Modal>
  );
}

const SLOTS: { id: Slot; label: string }[] = [
  { id: 'top-left', label: 'Cabeçalho à esquerda' }, { id: 'top-center', label: 'Cabeçalho ao centro' }, { id: 'top-right', label: 'Cabeçalho à direita' },
  { id: 'bottom-left', label: 'Rodapé à esquerda' }, { id: 'bottom-center', label: 'Rodapé ao centro' }, { id: 'bottom-right', label: 'Rodapé à direita' },
];

export function HeaderFooterDialog() {
  const n = useStore((s) => s.pageSizes.length);
  const [slots, setSlots] = useState<Partial<Record<Slot, string>>>({ 'bottom-center': 'Página {n} de {total}' });
  const [size, setSize] = useState(10);
  const [margin, setMargin] = useState(24);
  const [startAt, setStartAt] = useState(1);
  const [pages, setPages] = useState('');
  const s = useStore.getState;
  const run = () =>
    s().run('Aplicando…', async () => {
      const idx = resolvePages(pages, n);
      await s().apply('Cabeçalho e rodapé', (b) => addHeaderFooter(b, { slots, size, color: '#000000', font: 'Helvetica', margin, startAt, pages: idx }));
      close();
    });
  return (
    <Modal title="Cabeçalho, rodapé e numeração" onClose={close} wide footer={<button className="primary" onClick={run}>Aplicar</button>}>
      <p className="hint">Use {'{n}'} para o número da página, {'{total}'} para o total e {'{data}'} para a data de hoje.</p>
      <div className="grid3">
        {SLOTS.map((sl) => (
          <Field key={sl.id} label={sl.label}>
            <input value={slots[sl.id] ?? ''} onChange={(e) => setSlots({ ...slots, [sl.id]: e.target.value })} />
          </Field>
        ))}
      </div>
      <div className="grid3">
        <Field label="Tamanho da fonte"><input type="number" min={5} max={48} value={size} onChange={(e) => setSize(Number(e.target.value))} /></Field>
        <Field label="Margem (pt)"><input type="number" min={0} max={200} value={margin} onChange={(e) => setMargin(Number(e.target.value))} /></Field>
        <Field label="Começar a numeração em"><input type="number" min={0} value={startAt} onChange={(e) => setStartAt(Number(e.target.value))} /></Field>
      </div>
      <PagesField value={pages} onChange={setPages} />
    </Modal>
  );
}

export function PropertiesDialog() {
  const bytes = useStore((s) => s.bytes);
  const fileName = useStore((s) => s.fileName);
  const sizes = useStore((s) => s.pageSizes);
  const current = useStore((s) => s.currentPage);
  const security = useStore((s) => s.security);
  const [m, setM] = useState<Metadata | null>(null);
  const s = useStore.getState;
  useEffect(() => {
    if (bytes) getMetadata(bytes).then(setM).catch(() => setM({ title: '', author: '', subject: '', keywords: '', creator: '', producer: '' }));
  }, [bytes]);
  if (!m || !bytes) return null;
  const version = new TextDecoder().decode(bytes.subarray(0, 8)).match(/%PDF-(\d\.\d)/)?.[1] ?? '?';
  const p = sizes[current];
  const mm = (v: number) => Math.round((v * 25.4) / 72);
  const save = () =>
    s().run('Salvando propriedades…', async () => {
      await s().apply('Propriedades', (b) => setMetadata(b, m));
      close();
    });
  return (
    <Modal title="Propriedades do documento" onClose={close} wide footer={<button className="primary" onClick={save}>Salvar propriedades</button>}>
      <dl className="info">
        <dt>Arquivo</dt><dd>{fileName}</dd>
        <dt>Tamanho</dt><dd>{formatSize(bytes.length)}</dd>
        <dt>Páginas</dt><dd>{sizes.length}</dd>
        <dt>Página atual</dt><dd>{p ? `${mm(p.w)} × ${mm(p.h)} mm` : '—'}</dd>
        <dt>Versão do PDF</dt><dd>{version}</dd>
        <dt>Proteção</dt><dd>{security ? 'Senha (AES-256 ao salvar)' : 'Nenhuma'}</dd>
      </dl>
      <div className="grid2">
        {(['title', 'author', 'subject', 'keywords', 'creator', 'producer'] as const).map((k) => (
          <Field key={k} label={{ title: 'Título', author: 'Autor', subject: 'Assunto', keywords: 'Palavras-chave', creator: 'Aplicativo de criação', producer: 'Produtor' }[k]}>
            <input value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
    </Modal>
  );
}
