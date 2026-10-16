import {
  ArrowUpRight, ChevronLeft, ChevronRight, Circle, Eraser, FileSignature, FolderOpen, Hand, Highlighter, Image,
  LayoutGrid, Minus, MousePointer2, PenLine, PenTool, Plus, Printer, Redo2, Save, Square, Strikethrough,
  TextCursorInput, Type, Underline, FormInput, Link2, Undo2, MessageSquare, SquareDashed, Signature, Maximize2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { saveDocument, printDocument } from '../lib/actions';
import { pickFiles } from '../lib/files';
import { openFile } from '../lib/openFlow';
import { useStore, type Tool } from '../store';

export function TopBar() {
  const fileName = useStore((s) => s.fileName);
  const dirty = useStore((s) => s.dirty);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const zoom = useStore((s) => s.zoom);
  const current = useStore((s) => s.currentPage);
  const total = useStore((s) => s.pageSizes.length);
  const hasDoc = useStore((s) => !!s.bytes);
  const security = useStore((s) => !!s.security);
  const s = useStore.getState;
  const [pageInput, setPageInput] = useState('1');
  useEffect(() => setPageInput(String(current + 1)), [current]);

  const fitWidth = () => {
    const el = document.querySelector('.viewer');
    const maxW = Math.max(...s().pageSizes.map((p) => p.w));
    if (el && maxW) s().setZoom((el.clientWidth - 48) / maxW);
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">PDF</span> Studio
      </div>
      <button title="Abrir (Ctrl+O)" onClick={async () => { const [f] = await pickFiles('application/pdf,.pdf'); if (f) await openFile(f); }}>
        <FolderOpen size={18} /> <span className="label">Abrir</span>
      </button>
      <button title="Salvar (Ctrl+S)" disabled={!hasDoc} onClick={() => saveDocument()}>
        <Save size={18} /> <span className="label">Salvar</span>
      </button>
      <button className="icon" title="Imprimir (Ctrl+P)" disabled={!hasDoc} onClick={printDocument}><Printer size={18} /></button>
      <span className="sep" />
      <button className="icon" title="Desfazer (Ctrl+Z)" disabled={!canUndo} onClick={() => s().undo()}><Undo2 size={18} /></button>
      <button className="icon" title="Refazer (Ctrl+Y)" disabled={!canRedo} onClick={() => s().redo()}><Redo2 size={18} /></button>
      {hasDoc && (
        <>
          <span className="sep" />
          <div className="pager">
            <button className="icon" title="Página anterior" onClick={() => s().goToPage(current - 1)} disabled={current === 0}><ChevronLeft size={18} /></button>
            <input
              aria-label="Página atual"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && s().goToPage(parseInt(pageInput, 10) - 1)}
              onBlur={() => setPageInput(String(current + 1))}
            />
            <span>/ {total}</span>
            <button className="icon" title="Próxima página" onClick={() => s().goToPage(current + 1)} disabled={current >= total - 1}><ChevronRight size={18} /></button>
          </div>
          <span className="sep" />
          <div className="zoom">
            <button className="icon" title="Diminuir zoom" onClick={() => s().setZoom(zoom / 1.2)}><Minus size={18} /></button>
            <select value="" onChange={(e) => (e.target.value === 'fit' ? fitWidth() : s().setZoom(Number(e.target.value)))} aria-label="Zoom">
              <option value="" hidden>{Math.round(zoom * 100)}%</option>
              {[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((z) => <option key={z} value={z}>{z * 100}%</option>)}
              <option value="fit">Ajustar à largura</option>
            </select>
            <button className="icon" title="Aumentar zoom" onClick={() => s().setZoom(zoom * 1.2)}><Plus size={18} /></button>
            <button className="icon" title="Ajustar à largura" onClick={fitWidth}><Maximize2 size={16} /></button>
          </div>
        </>
      )}
      <div className="spacer" />
      {hasDoc && (
        <span className="doc-name" title={fileName}>
          {security && '🔒 '}
          {fileName}
          {dirty && <span className="dirty" title="Alterações não salvas"> •</span>}
        </span>
      )}
      <button className="primary" onClick={() => s().openDialog('tools')}>
        <LayoutGrid size={18} /> <span className="label">Ferramentas</span>
      </button>
    </header>
  );
}

const TOOLS: ({ id: Tool; label: string; icon: typeof Type; key?: string } | 'sep')[] = [
  { id: 'select', label: 'Selecionar', icon: MousePointer2, key: 'V' },
  { id: 'hand', label: 'Mão (mover a página)', icon: Hand, key: 'H' },
  'sep',
  { id: 'editText', label: 'Editar texto existente', icon: TextCursorInput, key: 'E' },
  { id: 'text', label: 'Adicionar texto', icon: Type, key: 'T' },
  'sep',
  { id: 'highlight', label: 'Destacar texto', icon: Highlighter },
  { id: 'underline', label: 'Sublinhar', icon: Underline },
  { id: 'strike', label: 'Tachar', icon: Strikethrough },
  { id: 'note', label: 'Comentário', icon: MessageSquare, key: 'C' },
  'sep',
  { id: 'ink', label: 'Desenho livre', icon: PenTool, key: 'D' },
  { id: 'rect', label: 'Retângulo', icon: Square },
  { id: 'ellipse', label: 'Elipse', icon: Circle },
  { id: 'line', label: 'Linha', icon: PenLine },
  { id: 'arrow', label: 'Seta', icon: ArrowUpRight },
  { id: 'image', label: 'Imagem', icon: Image },
  'sep',
  { id: 'whiteout', label: 'Apagar (cobrir com branco)', icon: Eraser },
  { id: 'redact', label: 'Redigir (remover conteúdo sigiloso)', icon: SquareDashed },
  'sep',
  { id: 'signature', label: 'Preencher e assinar (assinatura eletrônica)', icon: Signature },
  { id: 'digitalSignature', label: 'Assinatura digital com certificado', icon: FileSignature },
  'sep',
  { id: 'field', label: 'Criar campo de formulário', icon: FormInput, key: 'F' },
  { id: 'link', label: 'Criar link', icon: Link2, key: 'L' },
];

export function EditBar() {
  const tool = useStore((s) => s.tool);
  const s = useStore.getState;
  const choose = (id: Tool) => {
    if (id === 'signature') {
      s().openDialog('signature');
      return;
    }
    if (id === 'digitalSignature') {
      s().toast('Desenhe na página o retângulo onde a assinatura vai aparecer.');
    }
    if (id === 'redact' && !localStorage.getItem('pdfstudio.redactInfo')) {
      localStorage.setItem('pdfstudio.redactInfo', '1');
      s().toast('Marque as áreas sigilosas. Ao salvar, essas páginas viram imagem e o conteúdo coberto é apagado de verdade.');
    }
    s().setTool(id);
  };
  return (
    <div className="editbar" role="toolbar" aria-label="Ferramentas de edição">
      {TOOLS.map((t, i) =>
        t === 'sep' ? (
          <span key={i} className="sep" />
        ) : (
          <button key={t.id} className={`icon ${tool === t.id ? 'active' : ''}`} title={t.label + (t.key ? ` (${t.key})` : '')} aria-label={t.label}
            aria-pressed={tool === t.id} onClick={() => choose(t.id)}>
            <t.icon size={19} />
          </button>
        ),
      )}
    </div>
  );
}

export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(
  TOOLS.filter((t): t is Exclude<typeof t, 'sep'> => t !== 'sep' && !!t.key).map((t) => [t.key!.toLowerCase(), t.id]),
);
