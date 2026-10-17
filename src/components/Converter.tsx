import JSZip from 'jszip';
import { CheckCircle2, Copy, Download, FileUp, Loader2, ScanText, Trash2, XCircle } from 'lucide-react';
import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { browserDeps, browserPlatform } from '../convert/browserPlatform';
import { convertInput } from '../convert/convertFile';
import { ConversionCancelled, DEFAULT_OPTIONS, type ConvertOptions } from '../convert/engine';
import { ACCEPT, detectKind } from '../convert/inputs';
import { blocksToMarkdown } from '../convert/markdown';
import { FORMAT_INFO, render, type OutputFormat } from '../convert/outputs';
import type { ConvertedDocument } from '../convert/types';
import { baseName, download } from '../lib/bytes';
import { pickFiles } from '../lib/files';
import { ask } from '../lib/prompt';
import { useStore } from '../store';
import { Check, Field, Progress } from './ui';

interface Job {
  id: number;
  name: string;
  bytes: Uint8Array;
  status: 'aguardando' | 'convertendo' | 'pronto' | 'erro';
  progress: number;
  message: string;
  startedAt?: number;
  result?: ConvertedDocument;
  error?: string;
}

let nextId = 1;

/** Lista de arquivos do Conversor; fica guardada ao alternar entre Editor e Conversor. */
const useJobs = create<{ jobs: Job[]; selected: number | null }>(() => ({ jobs: [], selected: null }));
type JobsUpdater = Job[] | ((js: Job[]) => Job[]);
const setJobs = (u: JobsUpdater) => useJobs.setState((st) => ({ jobs: typeof u === 'function' ? u(st.jobs) : u }));
const setSelected = (u: number | null | ((s: number | null) => number | null)) =>
  useJobs.setState((st) => ({ selected: typeof u === 'function' ? u(st.selected) : u }));

/** Nomes únicos para o .zip ("relatorio.pdf" e "relatorio.docx" não podem virar o mesmo arquivo). */
function uniqueBases(jobs: Job[]): Map<number, string> {
  const out = new Map<number, string>();
  const used = new Map<string, number>();
  for (const j of jobs) {
    let base = baseName(j.name);
    const n = used.get(base.toLowerCase()) ?? 0;
    used.set(base.toLowerCase(), n + 1);
    if (n > 0) base = `${base}-${j.name.split('.').pop()?.toLowerCase() ?? n + 1}`;
    out.set(j.id, base);
  }
  return out;
}
const OPTIONS_KEY = 'pdfstudio.converter';

function loadOptions(): { format: OutputFormat; opts: ConvertOptions } {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null');
    if (saved) return { format: saved.format ?? 'md-zip', opts: { ...DEFAULT_OPTIONS, ...saved.opts } };
  } catch {
    /* preferências inválidas */
  }
  return { format: 'md-zip', opts: DEFAULT_OPTIONS };
}

/** Arquivos enviados ao Conversor a partir de outras telas (ex.: documento aberto no editor). */
export const converterInbox: { name: string; bytes: Uint8Array }[] = [];

/** Estimativa de tempo restante a partir do ritmo atual. */
function remaining(j: Job): string {
  if (!j.startedAt || j.progress < 0.04) return '';
  const elapsed = (Date.now() - j.startedAt) / 1000;
  const left = (elapsed / j.progress) * (1 - j.progress);
  if (left < 20) return ' · quase pronto';
  return left < 90 ? ` · ~${Math.round(left / 10) * 10} s restantes` : ` · ~${Math.round(left / 60)} min restantes`;
}

export function Converter() {
  const initial = useMemo(loadOptions, []);
  const jobs = useJobs((st) => st.jobs);
  const selected = useJobs((st) => st.selected);
  const [format, setFormat] = useState<OutputFormat>(initial.format);
  const [opts, setOpts] = useState<ConvertOptions>(initial.opts);
  const [tab, setTab] = useState<'preview' | 'markdown'>('preview');
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const toast = useStore.getState().toast;

  useEffect(() => {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify({ format, opts: { ...opts, onProgress: undefined } }));
    } catch {
      /* armazenamento indisponível */
    }
  }, [format, opts]);

  const update = (id: number, patch: Partial<Job>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const addFiles = async (files: { name: string; bytes: Uint8Array }[]) => {
    const ok = files.filter((f) => detectKind(f.name));
    const rejected = files.length - ok.length;
    if (rejected) toast(`${rejected} arquivo(s) ignorado(s): formato não suportado.`, 'error');
    const added = ok.map((f) => ({ id: nextId++, name: f.name, bytes: f.bytes, status: 'aguardando' as const, progress: 0, message: '' }));
    setJobs((js) => [...js, ...added]);
    if (added[0]) setSelected((s) => s ?? added[0].id);
    return added;
  };

  useEffect(() => {
    if (converterInbox.length) void addFiles(converterInbox.splice(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async () => {
    const files = await pickFiles(ACCEPT, true);
    await addFiles(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
  };

  const runAll = async () => {
    const pending = jobsRef.current.filter((j) => j.status === 'aguardando' || j.status === 'erro');
    if (!pending.length) return toast('Adicione arquivos para converter.');
    setRunning(true);
    const controller = new AbortController();
    abort.current = controller;
    let current = 0;
    const platform = browserPlatform((status, p) => {
      if (status === 'recognizing text') update(current, { progress: Math.max(0.05, p) });
    });
    const deps = browserDeps(platform, (name) => ask({ title: 'Documento protegido', message: `${name} é protegido por senha.`, label: 'Senha', password: true }));
    try {
      for (const job of pending) {
        current = job.id;
        if (controller.signal.aborted) break;
        update(job.id, { status: 'convertendo', progress: 0, message: 'Iniciando…', error: undefined, startedAt: Date.now() });
        try {
          const result = await convertInput({ name: job.name, bytes: job.bytes }, deps, {
            ...opts,
            signal: controller.signal,
            onProgress: (message, progress) => update(job.id, { message, progress }),
          });
          update(job.id, { status: 'pronto', progress: 1, message: '', result });
          setSelected((s) => s ?? job.id);
        } catch (e) {
          if (e instanceof ConversionCancelled) {
            update(job.id, { status: 'aguardando', progress: 0, message: 'Cancelado' });
            break;
          }
          console.error(e);
          update(job.id, { status: 'erro', message: '', error: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      abort.current = null;
      await platform.dispose();
      setRunning(false);
    }
  };

  const save = async (job: Job) => {
    if (!job.result) return;
    const base = baseName(job.name);
    const r = await render(job.result, format, base);
    download(r.bytes, `${base}.${r.ext}`, r.mime);
  };

  const saveAll = async () => {
    const done = jobs.filter((j) => j.result);
    if (!done.length) return toast('Nenhum arquivo convertido ainda.');
    if (done.length === 1) return save(done[0]);
    const zip = new JSZip();
    const bases = uniqueBases(done);
    for (const j of done) {
      const base = bases.get(j.id)!;
      const r = await render(j.result!, format, base);
      if (r.ext === 'zip') {
        // Cada documento numa pasta própria, com suas imagens.
        const inner = await JSZip.loadAsync(r.bytes);
        for (const [path, f] of Object.entries(inner.files)) if (!f.dir) zip.file(`${base}/${path}`, await f.async('uint8array'));
      } else zip.file(`${base}.${r.ext}`, r.bytes);
    }
    download(await zip.generateAsync({ type: 'blob' }), 'convertidos.zip');
  };

  const sel = jobs.find((j) => j.id === selected);
  const markdown = useMemo(() => (sel?.result ? blocksToMarkdown(sel.result.blocks, { imageDir: 'imagens' }) : ''), [sel?.result]);
  // Pré-visualização: imagens por endereço temporário (blob:), nunca embutidas como texto —
  // com centenas de imagens, o texto em base64 passaria do limite do navegador.
  const preview = useMemo(() => {
    if (!sel?.result) return { html: '', urls: [] as string[] };
    const urls: string[] = [];
    const blocks = sel.result.blocks.map((b) => {
      if (b.type !== 'image' || !b.data) return b;
      const url = URL.createObjectURL(new Blob([b.data as BlobPart], { type: b.mime ?? 'image/png' }));
      urls.push(url);
      return { ...b, name: url };
    });
    return { html: marked.parse(blocksToMarkdown(blocks, { imageDir: '' }), { async: false, gfm: true }) as string, urls };
  }, [sel?.result]);
  useEffect(() => () => preview.urls.forEach((u) => URL.revokeObjectURL(u)), [preview]);
  const previewHtml = preview.html;

  const set = (patch: Partial<ConvertOptions>) => setOpts((o) => ({ ...o, ...patch }));

  return (
    <div
      className={`converter ${dragOver ? 'drag' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        await addFiles(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
      }}
    >
      <section className="conv-side">
        <div className="conv-drop" onClick={pick} role="button" tabIndex={0}>
          <FileUp size={30} />
          <strong>Adicionar arquivos</strong>
          <small>PDF, imagens (JPG, PNG…), Word, HTML ou texto. Pode arrastar vários.</small>
        </div>

        <ul className="conv-jobs">
          {jobs.map((j) => (
            <li key={j.id} className={`${j.id === selected ? 'active' : ''} ${j.status}`} onClick={() => setSelected(j.id)}>
              <div className="job-head">
                {j.status === 'pronto' && <CheckCircle2 size={16} className="ok" />}
                {j.status === 'erro' && <XCircle size={16} className="bad" />}
                {j.status === 'convertendo' && <Loader2 size={16} className="spin" />}
                <span className="name" title={j.name}>{j.name}</span>
                <button className="icon" title="Remover" disabled={j.status === 'convertendo'}
                  onClick={(e) => { e.stopPropagation(); setJobs((js) => js.filter((x) => x.id !== j.id)); if (selected === j.id) setSelected(null); }}>
                  <Trash2 size={14} />
                </button>
              </div>
              {j.status === 'convertendo' && (<><Progress value={j.progress} /><small>{j.message}{remaining(j)}</small></>)}
              {j.status === 'aguardando' && j.message && <small>{j.message}</small>}
              {j.status === 'erro' && <small className="bad">{j.error}</small>}
              {j.result && (
                <small>
                  {j.result.pageCount} pág. · {j.result.blocks.length} blocos
                  {j.result.ocrPages.length > 0 && ` · OCR em ${j.result.ocrPages.length} pág.`}
                  {j.result.ocrImages > 0 && ` · texto lido em ${j.result.ocrImages} imagem(ns)`}
                  {j.result.imageOcrLimited && ' (limite de imagens atingido)'}
                </small>
              )}
            </li>
          ))}
        </ul>

        <div className="conv-options">
          <Field label="Converter para">
            <select value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
              {(Object.keys(FORMAT_INFO) as OutputFormat[]).map((f) => <option key={f} value={f}>{FORMAT_INFO[f].label}</option>)}
            </select>
          </Field>
          <Field label="Reconhecimento de texto (OCR)" hint="Automático: só onde o PDF não tem texto confiável (escaneado ou texto que não dá para copiar).">
            <select value={opts.ocr} onChange={(e) => set({ ocr: e.target.value as ConvertOptions['ocr'] })}>
              <option value="auto">Automático (recomendado)</option>
              <option value="always">Sempre (refazer todas as páginas)</option>
              <option value="never">Nunca</option>
            </select>
          </Field>
          <Field label="Idioma do texto">
            <select value={opts.langs} onChange={(e) => set({ langs: e.target.value })}>
              <option value="por+eng">Português + Inglês</option>
              <option value="por">Português</option>
              <option value="eng">Inglês</option>
            </select>
          </Field>
          <Check label="Ler o texto dentro de imagens (gráficos, prints)" checked={opts.ocrImages} onChange={(v) => set({ ocrImages: v })} />
          <Check label="Extrair as imagens" checked={opts.images} onChange={(v) => set({ images: v })} />
          <Check label="Remover cabeçalhos, rodapés e nº de página" checked={opts.removeHeaders} onChange={(v) => set({ removeHeaders: v })} />
        </div>

        <div className="conv-actions">
          {running ? (
            <button className="danger" onClick={() => abort.current?.abort()}><XCircle size={16} /> Cancelar</button>
          ) : (
            <button className="primary" onClick={runAll} disabled={!jobs.length}>
              <ScanText size={16} /> Converter
            </button>
          )}
          <button onClick={saveAll} disabled={!jobs.some((j) => j.result)}><Download size={16} /> Baixar {jobs.filter((j) => j.result).length > 1 ? 'todos (.zip)' : ''}</button>
        </div>
        <p className="privacy-note">Tudo é processado neste computador; nenhum arquivo é enviado para a internet.</p>
      </section>

      <section className="conv-preview">
        {!sel?.result ? (
          <div className="conv-empty">
            {sel?.status === 'convertendo' ? <p>Convertendo {sel.name}…</p> : sel?.status === 'erro' ? <p className="bad">{sel.error}</p> : (
              <>
                <h2>Conversor</h2>
                <p>Transforme PDFs, digitalizações e fotos de documentos em Markdown, Word, HTML ou texto, preservando títulos, listas, tabelas e links.</p>
                <p>Páginas escaneadas e textos que "não dá para copiar" passam pelo OCR automaticamente.</p>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="conv-toolbar">
              <div className="segmented">
                <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Visualizar</button>
                <button className={tab === 'markdown' ? 'active' : ''} onClick={() => setTab('markdown')}>Markdown</button>
              </div>
              <span className="spacer" />
              <button onClick={() => navigator.clipboard.writeText(markdown).then(() => toast('Markdown copiado.', 'success'))}><Copy size={16} /> Copiar Markdown</button>
              <button className="primary" onClick={() => save(sel)}><Download size={16} /> Baixar {FORMAT_INFO[format].label.replace(/ \(.*\)/, '')}</button>
            </div>
            {sel.result.ocrPages.length > 0 && (
              <p className="conv-note">
                OCR aplicado nas páginas {sel.result.ocrPages.map((p) => p.page + 1).join(', ')}
                {sel.result.ocrPages.some((p) => p.reason === 'texto-ilegivel') && ' (o texto original não podia ser copiado corretamente)'}.
                Confira nomes e números importantes: o reconhecimento pode errar em letras pequenas ou borradas.
              </p>
            )}
            {tab === 'preview' ? (
              <article
                className="md-preview"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
                onClick={(e) => {
                  // Links da pré-visualização abrem fora do app (nova aba ou navegador padrão).
                  const a = (e.target as HTMLElement).closest('a');
                  if (!a) return;
                  e.preventDefault();
                  const href = a.getAttribute('href') ?? '';
                  if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
                }}
              />
            ) : (
              <textarea className="md-source" readOnly value={markdown} spellCheck={false} />
            )}
          </>
        )}
      </section>
      {dragOver && <div className="drop-overlay">Solte os arquivos para converter</div>}
    </div>
  );
}
