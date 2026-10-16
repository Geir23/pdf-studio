import {
  ArrowDown, ArrowUp, BookMarked, Copy, Crosshair, Download, Pencil, Plus, FilePlus2, FileStack, FileSignature, FormInput, Layers, MessageSquare, RotateCcw,
  RotateCw, Search, ShieldCheck, ShieldAlert, Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { baseName, download } from '../lib/bytes';
import { pickFiles } from '../lib/files';
import { readPdfFile } from '../lib/openFlow';
import { pageLines } from '../pdf/convert';
import { readOutline, writeOutline, type OutlineItem } from '../pdf/outline';
import {
  deletePages, duplicatePages, extractPages, insertBlankPage, insertPdf, reorderPages, rotatePages,
} from '../pdf/pages';
import { renderPageToCanvas } from '../pdf/render';
import { fillForm, getFormFields, type FieldInfo } from '../pdf/tools';
import { verifySignatures, type SignatureReport } from '../pdf/verify';
import { useStore } from '../store';
import { Check } from './ui';

type Panel = 'pages' | 'outline' | 'search' | 'comments' | 'form' | 'signatures';

const PANELS: { id: Panel; label: string; icon: typeof Layers }[] = [
  { id: 'pages', label: 'Páginas', icon: Layers },
  { id: 'outline', label: 'Marcadores', icon: BookMarked },
  { id: 'search', label: 'Pesquisar', icon: Search },
  { id: 'comments', label: 'Comentários', icon: MessageSquare },
  { id: 'form', label: 'Formulário', icon: FormInput },
  { id: 'signatures', label: 'Assinaturas', icon: FileSignature },
];

export function Sidebar({ panel, setPanel }: { panel: Panel | null; setPanel: (p: Panel | null) => void }) {
  return (
    <aside className={`sidebar ${panel ? 'open' : ''}`}>
      <nav className="sidebar-tabs">
        {PANELS.map(({ id, label, icon: Icon }) => (
          <button key={id} className={`icon ${panel === id ? 'active' : ''}`} title={label} aria-label={label}
            onClick={() => setPanel(panel === id ? null : id)}>
            <Icon size={20} />
          </button>
        ))}
      </nav>
      {panel && (
        <div className="sidebar-panel">
          <h3>{PANELS.find((p) => p.id === panel)!.label}</h3>
          {panel === 'pages' && <PagesPanel />}
          {panel === 'outline' && <OutlinePanel />}
          {panel === 'search' && <SearchPanel />}
          {panel === 'comments' && <CommentsPanel />}
          {panel === 'form' && <FormPanel />}
          {panel === 'signatures' && <SignaturesPanel />}
        </div>
      )}
    </aside>
  );
}

export type { Panel };

// ---------------- Páginas ----------------

function Thumb({ index, selected, onClick, onDragStart, onDrop }: {
  index: number; selected: boolean; onClick: (e: React.MouseEvent) => void;
  onDragStart: () => void; onDrop: (before: boolean) => void;
}) {
  const view = useStore((s) => s.view);
  const version = useStore((s) => s.version);
  const current = useStore((s) => s.currentPage === index);
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [over, setOver] = useState<'before' | 'after' | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !view) return;
    let cancelled = false;
    const io = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      const page = await view.getPage(index + 1);
      const vp = page.getViewport({ scale: 1 });
      const canvas = await renderPageToCanvas(view, index, 220 / Math.max(vp.width, vp.height));
      if (!cancelled) setSrc(canvas.toDataURL('image/jpeg', 0.8));
    }, { root: el.closest('.sidebar-panel'), rootMargin: '300px' });
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [view, version, index]);

  return (
    <div
      ref={ref}
      className={`thumb ${selected ? 'selected' : ''} ${current ? 'current' : ''} ${over ? `drop-${over}` : ''}`}
      draggable
      onClick={onClick}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setOver(e.clientY < r.top + r.height / 2 ? 'before' : 'after');
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(over === 'before');
        setOver(null);
      }}
    >
      {src ? <img src={src} alt={`Página ${index + 1}`} /> : <div className="thumb-placeholder" />}
      <span>{index + 1}</span>
    </div>
  );
}

function PagesPanel() {
  const n = useStore((s) => s.pageSizes.length);
  const selected = useStore((s) => s.selectedPages);
  const fileName = useStore((s) => s.fileName);
  const anchor = useRef(0);
  const dragging = useRef<number | null>(null);
  const s = useStore.getState;

  const targets = () => (selected.length ? selected : [s().currentPage]);

  const click = (i: number, e: React.MouseEvent) => {
    let next: number[];
    if (e.shiftKey) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      next = Array.from({ length: b - a + 1 }, (_, k) => a + k);
    } else if (e.ctrlKey || e.metaKey) {
      next = selected.includes(i) ? selected.filter((p) => p !== i) : [...selected, i].sort((a, b) => a - b);
      anchor.current = i;
    } else {
      next = [i];
      anchor.current = i;
    }
    s().setSelectedPages(next);
    s().goToPage(i);
  };

  const drop = (target: number, before: boolean) => {
    const from = dragging.current;
    dragging.current = null;
    if (from === null) return;
    const moving = selected.includes(from) ? selected : [from];
    const rest = Array.from({ length: n }, (_, k) => k).filter((k) => !moving.includes(k));
    let at = rest.indexOf(target);
    if (at === -1) return; // soltou sobre uma das páginas sendo movidas
    if (!before) at += 1;
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    if (order.every((v, k) => v === k)) return;
    void s().run('Reordenando páginas…', async () => {
      await s().apply('Reordenar páginas', (b) => reorderPages(b, order));
      s().setSelectedPages(moving.map((m) => order.indexOf(m)));
    });
  };

  const act = (label: string, op: (b: Uint8Array) => Promise<Uint8Array>) =>
    s().run(`${label}…`, () => s().apply(label, op));

  return (
    <>
      <div className="page-actions">
        <button className="icon" title="Girar à esquerda" onClick={() => act('Girar páginas', (b) => rotatePages(b, targets(), -90))}><RotateCcw size={18} /></button>
        <button className="icon" title="Girar à direita" onClick={() => act('Girar páginas', (b) => rotatePages(b, targets(), 90))}><RotateCw size={18} /></button>
        <button className="icon" title="Duplicar" onClick={() => act('Duplicar páginas', (b) => duplicatePages(b, targets()))}><Copy size={18} /></button>
        <button className="icon" title="Inserir página em branco depois" onClick={() => act('Inserir página', (b) => insertBlankPage(b, Math.max(...targets()) + 1))}><FilePlus2 size={18} /></button>
        <button className="icon" title="Inserir outro PDF depois da página" onClick={async () => {
          const [file] = await pickFiles('application/pdf');
          if (!file) return;
          const other = await readPdfFile(file);
          if (other) await act('Inserir PDF', (b) => insertPdf(b, other.bytes, Math.max(...targets()) + 1));
        }}><FileStack size={18} /></button>
        <button className="icon" title="Extrair páginas selecionadas (baixar)" onClick={() => s().run('Extraindo…', async () => {
          const pages = targets();
          download(await extractPages(await s().bake(), pages), `${baseName(fileName)}-paginas.pdf`);
        })}><Download size={18} /></button>
        <button className="icon danger" title="Excluir páginas" onClick={() => {
          const t = targets();
          if (window.confirm(`Excluir ${t.length === 1 ? 'a página ' + (t[0] + 1) : t.length + ' páginas'}?`)) {
            void act('Excluir páginas', (b) => deletePages(b, t)).then(() => s().setSelectedPages([]));
          }
        }}><Trash2 size={18} /></button>
      </div>
      <p className="hint">Clique para selecionar (Ctrl/Shift para várias). Arraste para reordenar.</p>
      <div className="thumbs">
        {Array.from({ length: n }, (_, i) => (
          <Thumb key={i} index={i} selected={selected.includes(i)} onClick={(e) => click(i, e)}
            onDragStart={() => (dragging.current = i)} onDrop={(before) => drop(i, before)} />
        ))}
      </div>
    </>
  );
}


// ---------------- Marcadores ----------------

type Path = number[];

function getList(tree: OutlineItem[], path: Path): OutlineItem[] {
  return path.slice(0, -1).reduce((list, i) => list[i].children, tree);
}

function OutlinePanel() {
  const bytes = useStore((s) => s.bytes);
  const [items, setItems] = useState<OutlineItem[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const s = useStore.getState;

  useEffect(() => {
    if (!bytes) return;
    readOutline(bytes).then(setItems).catch(() => setItems([]));
  }, [bytes]);

  const save = (next: OutlineItem[], label = 'Marcadores') => {
    setItems(next);
    void s().run('Atualizando marcadores…', () => s().apply(label, (b) => writeOutline(b, next)));
  };
  const clone = () => structuredClone(items ?? []);

  const add = (parent: Path | null) => {
    const next = clone();
    const node: OutlineItem = { title: `Página ${s().currentPage + 1}`, page: s().currentPage, children: [] };
    if (parent) {
      const list = getList(next, parent);
      list[parent[parent.length - 1]].children.push(node);
    } else next.push(node);
    save(next, 'Adicionar marcador');
  };
  const remove = (path: Path) => {
    const next = clone();
    getList(next, path).splice(path[path.length - 1], 1);
    save(next, 'Excluir marcador');
  };
  const move = (path: Path, d: number) => {
    const next = clone();
    const list = getList(next, path);
    const i = path[path.length - 1];
    if (i + d < 0 || i + d >= list.length) return;
    [list[i], list[i + d]] = [list[i + d], list[i]];
    save(next, 'Mover marcador');
  };
  const rename = (path: Path) => {
    const next = clone();
    const node = getList(next, path)[path[path.length - 1]];
    if (!draft.trim() || draft === node.title) return setEditing(null);
    node.title = draft.trim();
    setEditing(null);
    save(next, 'Renomear marcador');
  };
  const setPage = (path: Path) => {
    const next = clone();
    getList(next, path)[path[path.length - 1]].page = s().currentPage;
    save(next, 'Destino do marcador');
  };

  const render = (nodes: OutlineItem[], parent: Path) => (
    <ul className="outline">
      {nodes.map((n, i) => {
        const path = [...parent, i];
        const key = path.join('.');
        return (
          <li key={key}>
            <div className="outline-row">
              {editing === key ? (
                <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => rename(path)}
                  onKeyDown={(e) => { if (e.key === 'Enter') rename(path); if (e.key === 'Escape') setEditing(null); }} />
              ) : (
                <button className="link" onClick={() => n.page !== null && s().goToPage(n.page)} onDoubleClick={() => { setEditing(key); setDraft(n.title); }}
                  title={n.page !== null ? `Página ${n.page + 1} — clique duplo para renomear` : 'Destino desconhecido'}>{n.title}</button>
              )}
              <span className="outline-actions">
                <button className="icon" title="Renomear" onClick={() => { setEditing(key); setDraft(n.title); }}><Pencil size={13} /></button>
                <button className="icon" title="Apontar para a página atual" onClick={() => setPage(path)}><Crosshair size={13} /></button>
                <button className="icon" title="Adicionar submarcador (página atual)" onClick={() => add(path)}><Plus size={13} /></button>
                <button className="icon" title="Subir" onClick={() => move(path, -1)} disabled={i === 0}><ArrowUp size={13} /></button>
                <button className="icon" title="Descer" onClick={() => move(path, 1)} disabled={i === nodes.length - 1}><ArrowDown size={13} /></button>
                <button className="icon danger" title="Excluir" onClick={() => remove(path)}><Trash2 size={13} /></button>
              </span>
            </div>
            {n.children.length > 0 && render(n.children, path)}
          </li>
        );
      })}
    </ul>
  );

  if (items === null) return <p className="hint">Carregando…</p>;
  return (
    <>
      <button onClick={() => add(null)}><Plus size={16} /> Novo marcador (página atual)</button>
      {!items.length && <p className="hint">Este documento não tem marcadores.</p>}
      {render(items, [])}
    </>
  );
}

// ---------------- Pesquisa ----------------

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function SearchPanel() {
  const view = useStore((s) => s.view);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ page: number; before: string; match: string; after: string }[] | null>(null);
  const [active, setActive] = useState(-1);
  const pagesText = useRef<string[] | null>(null);

  useEffect(() => {
    pagesText.current = null;
    setResults(null);
  }, [view]);

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!view || !query.trim()) return;
    if (!pagesText.current) {
      const all: string[] = [];
      for (let i = 0; i < view.numPages; i++) all.push((await pageLines(view, i)).map((l) => l.text).join(' '));
      pagesText.current = all;
    }
    const q = norm(query.trim());
    const out: NonNullable<typeof results> = [];
    pagesText.current.forEach((text, page) => {
      const n = norm(text);
      if (n.length !== text.length) return void searchLoose(text, q, page, out);
      for (let at = n.indexOf(q); at !== -1 && out.length < 500; at = n.indexOf(q, at + q.length)) {
        out.push({ page, before: text.slice(Math.max(0, at - 30), at), match: text.slice(at, at + q.length), after: text.slice(at + q.length, at + q.length + 30) });
      }
    });
    setResults(out);
    setActive(-1);
    if (out.length) open(out, 0);
  };

  const open = (list: NonNullable<typeof results>, i: number) => {
    setActive(i);
    const r = list[i];
    useStore.getState().goToPage(r.page);
    useStore.getState().setSearchHighlight({ page: r.page, query: query.trim() });
  };

  return (
    <>
      <form onSubmit={search} className="search-form">
        <input autoFocus type="search" placeholder="Buscar no documento…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="primary" type="submit">Buscar</button>
      </form>
      {results && (
        <p className="hint">
          {results.length ? `${results.length} resultado(s)` : 'Nenhum resultado. Documento escaneado? Use Ferramentas › OCR.'}
          {results.length > 1 && (
            <>
              {' · '}
              <button className="link" onClick={() => open(results, (active - 1 + results.length) % results.length)}>anterior</button>
              {' · '}
              <button className="link" onClick={() => open(results, (active + 1) % results.length)}>próximo</button>
            </>
          )}
        </p>
      )}
      <ul className="results">
        {results?.map((r, i) => (
          <li key={i} className={i === active ? 'active' : ''} onClick={() => open(results, i)}>
            <small>Página {r.page + 1}</small>
            <span>…{r.before}<mark>{r.match}</mark>{r.after}…</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function searchLoose(text: string, q: string, page: number, out: { page: number; before: string; match: string; after: string }[]) {
  if (norm(text).includes(q)) out.push({ page, before: '', match: text.slice(0, 60), after: '' });
}

// ---------------- Comentários ----------------

interface ExistingAnnot {
  page: number;
  type: string;
  author: string;
  text: string;
}

const ANNOT_NAMES: Record<string, string> = {
  Text: 'Nota', FreeText: 'Texto', Highlight: 'Destaque', Underline: 'Sublinhado', StrikeOut: 'Tachado',
  Square: 'Retângulo', Circle: 'Elipse', Ink: 'Desenho', Line: 'Linha', Stamp: 'Carimbo', Polygon: 'Polígono',
};

function CommentsPanel() {
  const view = useStore((s) => s.view);
  const objects = useStore((s) => s.objects);
  const [existing, setExisting] = useState<ExistingAnnot[] | null>(null);

  useEffect(() => {
    if (!view) return;
    (async () => {
      const out: ExistingAnnot[] = [];
      for (let i = 0; i < view.numPages; i++) {
        const annots = await (await view.getPage(i + 1)).getAnnotations();
        for (const a of annots) {
          const text = a.contentsObj?.str ?? a.contents ?? '';
          if (!ANNOT_NAMES[a.subtype] || (!text && a.subtype === 'Text')) continue;
          out.push({ page: i, type: ANNOT_NAMES[a.subtype], author: a.titleObj?.str ?? '', text });
        }
      }
      setExisting(out);
    })();
  }, [view]);

  const pending = useMemo(() => objects.filter((o) => o.kind === 'note'), [objects]);
  const s = useStore.getState;

  return (
    <>
      <p className="hint">Use a ferramenta Comentário (ícone de balão) para adicionar notas.</p>
      <ul className="comments">
        {pending.map((o) => o.kind === 'note' && (
          <li key={o.id} onClick={() => { s().goToPage(o.page); s().setTool('select'); s().select(o.id); }}>
            <small>Página {o.page + 1} · {o.author || 'Você'} · não salvo</small>
            <span>{o.text || <em>(vazio)</em>}</span>
          </li>
        ))}
        {existing?.map((a, i) => (
          <li key={i} onClick={() => s().goToPage(a.page)}>
            <small>Página {a.page + 1} · {a.type}{a.author ? ` · ${a.author}` : ''}</small>
            <span>{a.text || <em>(sem texto)</em>}</span>
          </li>
        ))}
      </ul>
      {existing && !existing.length && !pending.length && <p className="hint">Nenhum comentário neste documento.</p>}
    </>
  );
}

// ---------------- Formulário ----------------

function FormPanel() {
  const bytes = useStore((s) => s.bytes);
  const [fields, setFields] = useState<FieldInfo[] | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>({});
  const [flatten, setFlatten] = useState(false);

  useEffect(() => {
    if (!bytes) return;
    getFormFields(bytes)
      .then((f) => {
        setFields(f);
        setValues(Object.fromEntries(f.filter((x) => 'value' in x).map((x) => [x.name, (x as { value: string }).value])));
      })
      .catch(() => setFields([]));
  }, [bytes]);

  if (fields === null) return <p className="hint">Carregando…</p>;
  if (!fields.length) {
    return <p className="hint">Este documento não tem campos de formulário. Para preencher um formulário sem campos, use a ferramenta Texto.</p>;
  }
  const set = (name: string, v: string | boolean | string[]) => setValues((old) => ({ ...old, [name]: v }));
  const s = useStore.getState;

  return (
    <form
      className="form-fields"
      onSubmit={(e) => {
        e.preventDefault();
        void s().run('Preenchendo formulário…', async () => {
          if (await s().apply('Preencher formulário', (b) => fillForm(b, values, flatten))) s().toast('Formulário atualizado.', 'success');
        });
      }}
    >
      {fields.map((f) => (
        <label key={f.name} className="field">
          <span>{f.name}{f.readOnly ? ' (somente leitura)' : ''}</span>
          {f.type === 'text' && (f.multiline
            ? <textarea disabled={f.readOnly} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />
            : <input disabled={f.readOnly} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />)}
          {f.type === 'checkbox' && <input type="checkbox" disabled={f.readOnly} checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked)} />}
          {(f.type === 'radio' || f.type === 'dropdown') && (
            <select disabled={f.readOnly} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)}>
              <option value="">—</option>
              {f.options.map((o) => <option key={o}>{o}</option>)}
            </select>
          )}
          {f.type === 'list' && (
            <select multiple disabled={f.readOnly} value={(values[f.name] as string[]) ?? []}
              onChange={(e) => set(f.name, Array.from(e.target.selectedOptions).map((o) => o.value))}>
              {f.options.map((o) => <option key={o}>{o}</option>)}
            </select>
          )}
          {f.type === 'other' && <small>Tipo de campo não editável aqui.</small>}
        </label>
      ))}
      <Check label="Achatar (campos deixam de ser editáveis)" checked={flatten} onChange={setFlatten} />
      <button className="primary" type="submit">Aplicar ao documento</button>
    </form>
  );
}

// ---------------- Assinaturas ----------------

function SignaturesPanel() {
  const bytes = useStore((s) => s.bytes);
  const [reports, setReports] = useState<SignatureReport[] | null>(null);
  useEffect(() => {
    if (!bytes) return;
    setReports(null);
    verifySignatures(bytes).then(setReports).catch(() => setReports([]));
  }, [bytes]);

  if (reports === null) return <p className="hint">Verificando…</p>;
  return (
    <>
      {!reports.length && <p className="hint">Nenhuma assinatura digital neste documento.</p>}
      <ul className="signatures">
        {reports.map((r, i) => (
          <li key={i} className={r.valid ? 'ok' : 'bad'}>
            <div className="sig-title">
              {r.valid ? <ShieldCheck size={18} /> : <ShieldAlert size={18} />}
              <strong>{r.signer || r.fieldName}</strong>
            </div>
            <small>{r.valid ? 'Assinatura íntegra: o conteúdo assinado não foi alterado.' : r.error ?? 'Assinatura inválida.'}</small>
            {r.signingTime && <small>Data: {r.signingTime.toLocaleString('pt-BR')}</small>}
            {r.reason && <small>Motivo: {r.reason}</small>}
            {r.issuer && <small>Emitido por: {r.issuer}{r.selfSigned ? ' (autoassinado)' : ''}</small>}
            {r.valid && !r.coversWholeDocument && <small className="warn">O documento recebeu alterações depois desta assinatura.</small>}
          </li>
        ))}
      </ul>
      {reports.length > 0 && (
        <p className="hint">
          A verificação confere a integridade criptográfica. A confiança na identidade do signatário
          (ex.: ICP-Brasil) depende da cadeia de certificação, que este app não valida.
        </p>
      )}
      <button className="secondary" onClick={() => { useStore.getState().setTool('digitalSignature'); useStore.getState().toast('Desenhe na página a área da assinatura.'); }}>
        Assinar digitalmente…
      </button>
    </>
  );
}
