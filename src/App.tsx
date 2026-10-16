import { Combine, FilePlus2, FolderOpen, Images, ShieldCheck, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PDFDocument, PageSizes } from 'pdf-lib';
import { DialogHost } from './components/dialogs';
import { finishEditing } from './components/Overlay';
import { Properties } from './components/Properties';
import { Sidebar, type Panel } from './components/Sidebar';
import { EditBar, TOOL_KEYS, TopBar } from './components/Toolbar';
import { Modal, Progress } from './components/ui';
import { printDocument, saveDocument } from './lib/actions';
import { pickFiles } from './lib/files';
import { desktop } from './lib/desktop';
import { openFile } from './lib/openFlow';
import { usePrompt } from './lib/prompt';
import { useStore } from './store';
import { Viewer } from './components/Viewer';

function Welcome() {
  const s = useStore.getState;
  return (
    <div className="welcome">
      <div className="drop-hint">
        <Upload size={48} />
        <h1>Arraste um PDF para cá</h1>
        <p>ou</p>
        <button className="primary big" onClick={async () => { const [f] = await pickFiles('application/pdf,.pdf'); if (f) await openFile(f); }}>
          <FolderOpen size={20} /> Abrir arquivo
        </button>
      </div>
      <div className="quick">
        <button onClick={() => s().openDialog('merge')}><Combine size={22} /> Combinar PDFs</button>
        <button onClick={() => s().openDialog('images')}><Images size={22} /> Imagens para PDF</button>
        <button onClick={() => s().run('Criando…', async () => {
          const doc = await PDFDocument.create();
          doc.addPage(PageSizes.A4);
          await s().load(await doc.save(), 'Novo documento.pdf');
          s().setTool('text');
        })}><FilePlus2 size={22} /> Documento em branco</button>
      </div>
      <p className="privacy"><ShieldCheck size={16} /> Seus arquivos são processados apenas neste computador. Nada é enviado para servidores.</p>
    </div>
  );
}

function BusyOverlay() {
  const busy = useStore((s) => s.busy);
  if (!busy) return null;
  return (
    <div className="busy" role="status" aria-live="polite">
      <div className="busy-box">
        <p>{busy.message}</p>
        <Progress value={busy.progress} />
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => useStore.getState().dismissToast(t.id)}>{t.text}</div>
      ))}
    </div>
  );
}

function PromptHost() {
  const req = usePrompt((s) => s.request);
  const [value, setValue] = useState('');
  useEffect(() => setValue(req?.initial ?? ''), [req]);
  if (!req) return null;
  return (
    <Modal title={req.title} top onClose={() => req.resolve(null)}
      footer={<><button onClick={() => req.resolve(null)}>Cancelar</button><button className="primary" onClick={() => req.resolve(value)}>OK</button></>}>
      {req.message && <p>{req.message}</p>}
      <label className="field">
        <span>{req.label}</span>
        <input autoFocus type={req.password ? 'password' : 'text'} value={value} onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && req.resolve(value)} />
      </label>
    </Modal>
  );
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

export default function App() {
  const hasDoc = useStore((s) => !!s.bytes);
  const [panel, setPanel] = useState<Panel | null>('pages');
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void saveDocument(e.shiftKey); return; }
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); void pickFiles('application/pdf,.pdf').then(([f]) => f && openFile(f)); return; }
      if (mod && e.key.toLowerCase() === 'p' && s.bytes) { e.preventDefault(); void printDocument(); return; }
      if (mod && e.key.toLowerCase() === 'f' && s.bytes) { e.preventDefault(); setPanel('search'); return; }
      if (isTyping(e) || s.dialog || usePrompt.getState().request) return;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); void (e.shiftKey ? s.redo() : s.undo()); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); void s.redo(); return; }
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); s.setZoom(s.zoom * 1.2); return; }
      if (mod && e.key === '-') { e.preventDefault(); s.setZoom(s.zoom / 1.2); return; }
      if (mod && e.key === '0') { e.preventDefault(); s.setZoom(1); return; }
      if (mod) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedId) { e.preventDefault(); s.removeObject(s.selectedId); return; }
      if (e.key === 'Escape') { if (s.editingId) finishEditing(); else { s.select(null); s.setTool('select'); s.setPendingSignature(null); } return; }
      if (e.key.startsWith('Arrow') && s.selectedId) {
        e.preventDefault();
        const o = s.objects.find((x) => x.id === s.selectedId)!;
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
        const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
        const patch = 'x1' in o ? { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy }
          : o.kind === 'ink' ? { points: o.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) }
          : { x: o.x + dx, y: o.y + dy };
        s.updateObject(o.id, patch);
        return;
      }
      if (e.key === 'PageDown') { s.goToPage(s.currentPage + 1); return; }
      if (e.key === 'PageUp') { s.goToPage(s.currentPage - 1); return; }
      const tool = TOOL_KEYS[e.key.toLowerCase()];
      if (tool && s.bytes) s.setTool(tool);
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      // No desktop quem pergunta é a janela nativa (ver electron/main.cjs).
      if (!desktop && useStore.getState().dirty) e.preventDefault();
    };
    const stopDirty = desktop ? useStore.subscribe((st, prev) => st.dirty !== prev.dirty && desktop!.setDirty(st.dirty)) : undefined;
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onUnload);
    // Versão desktop: arquivos abertos pelo Windows ("Abrir com", duplo clique).
    const stopDesktop = desktop?.onOpenFile((name, bytes) => void openFile(new File([bytes as BlobPart], name, { type: 'application/pdf' })));
    return () => {
      stopDesktop?.();
      stopDirty?.();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);

  return (
    <div
      className="app"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        const f = Array.from(e.dataTransfer.files).find((x) => x.type === 'application/pdf' || x.name.toLowerCase().endsWith('.pdf'));
        if (f) void openFile(f);
        else useStore.getState().toast('Solte um arquivo PDF. Para imagens, use Ferramentas › Imagens para PDF.', 'error');
      }}
    >
      <TopBar />
      {hasDoc && <EditBar />}
      <main>
        {hasDoc ? (
          <>
            <Sidebar panel={panel} setPanel={setPanel} />
            <Viewer />
            <Properties />
          </>
        ) : (
          <Welcome />
        )}
      </main>
      {dragOver && <div className="drop-overlay">Solte o PDF para abrir</div>}
      <DialogHost />
      <PromptHost />
      <BusyOverlay />
      <Toasts />
    </div>
  );
}
