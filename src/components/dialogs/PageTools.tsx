import JSZip from 'jszip';
import { ArrowDown, ArrowUp, FilePlus, X } from 'lucide-react';
import { useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import { baseName, download } from '../../lib/bytes';
import { pickFiles } from '../../lib/files';
import { readPdfFile } from '../../lib/openFlow';
import { cropPages, deletePages, everyN, extractPages, mergePdfs, parseGroups, splitPdf } from '../../pdf/pages';
import { useStore } from '../../store';
import { Check, Field, Modal } from '../ui';
import { PagesField, close, formatSize, resolvePages } from './common';

interface Item {
  name: string;
  bytes: Uint8Array;
  pages: number;
}

export function MergeDialog() {
  const hasDoc = useStore((s) => !!s.bytes);
  const fileName = useStore((s) => s.fileName);
  const [items, setItems] = useState<Item[]>([]);
  const [includeCurrent, setIncludeCurrent] = useState(hasDoc);
  const s = useStore.getState;

  const add = async () => {
    const files = await pickFiles('application/pdf,.pdf', true);
    const added: Item[] = [];
    for (const f of files) {
      const r = await s().run(`Lendo ${f.name}…`, () => readPdfFile(f));
      if (!r) continue;
      added.push({ name: f.name, bytes: r.bytes, pages: (await PDFDocument.load(r.bytes)).getPageCount() });
    }
    setItems((old) => [...old, ...added]);
  };

  const move = (i: number, d: number) =>
    setItems((old) => {
      const next = [...old];
      const [it] = next.splice(i, 1);
      next.splice(i + d, 0, it);
      return next;
    });

  const merge = async (open: boolean) => {
    await s().run('Combinando arquivos…', async () => {
      const list = [...(includeCurrent && hasDoc ? [await s().bake()] : []), ...items.map((i) => i.bytes)];
      if (list.length < 2) throw new Error('Escolha pelo menos dois arquivos para combinar.');
      const out = await mergePdfs(list);
      const name = `${baseName(includeCurrent && hasDoc ? fileName : items[0]?.name ?? 'documento')}-combinado.pdf`;
      if (open) {
        if (hasDoc && includeCurrent) await s().apply('Combinar arquivos', async () => out);
        else await s().load(out, name);
      } else {
        download(out, name);
      }
      close();
    });
  };

  return (
    <Modal title="Combinar arquivos" onClose={close} wide
      footer={<>
        <button onClick={() => merge(false)}>Baixar combinado</button>
        <button className="primary" onClick={() => merge(true)}>Combinar e abrir</button>
      </>}>
      <p className="hint">Junte vários PDFs em um só. Use as setas para definir a ordem.</p>
      {hasDoc && <Check label={`Começar pelo documento aberto (${fileName})`} checked={includeCurrent} onChange={setIncludeCurrent} />}
      <ul className="file-list">
        {items.map((it, i) => (
          <li key={i}>
            <span className="name">{it.name}</span>
            <small>{it.pages} pág. · {formatSize(it.bytes.length)}</small>
            <button className="icon" title="Subir" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={16} /></button>
            <button className="icon" title="Descer" disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown size={16} /></button>
            <button className="icon" title="Remover" onClick={() => setItems((o) => o.filter((_, k) => k !== i))}><X size={16} /></button>
          </li>
        ))}
      </ul>
      <button onClick={add}><FilePlus size={16} /> Adicionar PDFs…</button>
    </Modal>
  );
}

export function SplitDialog() {
  const n = useStore((s) => s.pageSizes.length);
  const fileName = useStore((s) => s.fileName);
  const [mode, setMode] = useState<'every' | 'ranges' | 'each'>('every');
  const [every, setEvery] = useState(1);
  const [ranges, setRanges] = useState('');
  const s = useStore.getState;

  const run = () =>
    s().run('Dividindo documento…', async () => {
      const groups = mode === 'each' ? everyN(n, 1) : mode === 'every' ? everyN(n, Math.max(1, every)) : parseGroups(ranges, n);
      if (!groups.length) throw new Error('Informe ao menos um intervalo.');
      const parts = await splitPdf(await s().bake(), groups);
      const base = baseName(fileName);
      const zip = new JSZip();
      parts.forEach((p, i) => {
        const g = groups[i];
        const label = g.length === 1 ? `${g[0] + 1}` : `${g[0] + 1}-${g[g.length - 1] + 1}`;
        zip.file(`${base}-p${label}.pdf`, p);
      });
      download(await zip.generateAsync({ type: 'blob' }), `${base}-dividido.zip`);
      s().toast(`${parts.length} arquivos gerados.`, 'success');
      close();
    });

  return (
    <Modal title="Dividir documento" onClose={close} footer={<button className="primary" onClick={run}>Dividir e baixar (.zip)</button>}>
      <label className="radio"><input type="radio" checked={mode === 'every'} onChange={() => setMode('every')} />
        A cada <input type="number" min={1} max={n} value={every} onChange={(e) => setEvery(Number(e.target.value))} className="inline-num" /> páginas
      </label>
      <label className="radio"><input type="radio" checked={mode === 'each'} onChange={() => setMode('each')} /> Uma página por arquivo</label>
      <label className="radio"><input type="radio" checked={mode === 'ranges'} onChange={() => setMode('ranges')} /> Intervalos personalizados</label>
      {mode === 'ranges' && (
        <Field label="Um arquivo por linha (ou separados por ;)" hint="Ex.: 1-3; 4-6; 7,9">
          <textarea rows={4} value={ranges} onChange={(e) => setRanges(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}

export function ExtractDialog() {
  const fileName = useStore((s) => s.fileName);
  const n = useStore((s) => s.pageSizes.length);
  const selected = useStore((s) => s.selectedPages);
  const [pages, setPages] = useState(selected.map((p) => p + 1).join(', '));
  const [remove, setRemove] = useState(false);
  const s = useStore.getState;
  const run = () =>
    s().run('Extraindo páginas…', async () => {
      const idx = resolvePages(pages, n);
      download(await extractPages(await s().bake(), idx), `${baseName(fileName)}-extraido.pdf`);
      if (remove) await s().apply('Excluir páginas extraídas', (b) => deletePages(b, idx));
      close();
    });
  return (
    <Modal title="Extrair páginas" onClose={close} footer={<button className="primary" onClick={run}>Extrair</button>}>
      <PagesField value={pages} onChange={setPages} />
      <Check label="Excluir as páginas extraídas deste documento" checked={remove} onChange={setRemove} />
    </Modal>
  );
}

export function CropDialog() {
  const n = useStore((s) => s.pageSizes.length);
  const [pages, setPages] = useState('');
  const [m, setM] = useState({ top: 10, right: 10, bottom: 10, left: 10 });
  const s = useStore.getState;
  const mm = (v: number) => (v * 72) / 25.4;
  const run = () =>
    s().run('Cortando páginas…', async () => {
      const idx = resolvePages(pages, n);
      await s().apply('Cortar páginas', (b) => cropPages(b, idx, { top: mm(m.top), right: mm(m.right), bottom: mm(m.bottom), left: mm(m.left) }));
      close();
    });
  return (
    <Modal title="Cortar páginas" onClose={close} footer={<button className="primary" onClick={run}>Cortar</button>}>
      <p className="hint">Remove margens das páginas (medidas na orientação original da página).</p>
      <div className="grid2">
        {(['top', 'bottom', 'left', 'right'] as const).map((k) => (
          <Field key={k} label={{ top: 'Superior', bottom: 'Inferior', left: 'Esquerda', right: 'Direita' }[k] + ' (mm)'}>
            <input type="number" min={0} value={m[k]} onChange={(e) => setM({ ...m, [k]: Math.max(0, Number(e.target.value)) })} />
          </Field>
        ))}
      </div>
      <PagesField value={pages} onChange={setPages} />
    </Modal>
  );
}
