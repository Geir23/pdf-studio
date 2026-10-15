import { ArrowDown, ArrowUp, ImagePlus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { baseName, download } from '../../lib/bytes';
import { pickFiles } from '../../lib/files';
import { readPdfFile } from '../../lib/openFlow';
import { compareDocuments, type PageDiff } from '../../pdf/compare';
import { imagesToPdf, pdfToDocx, pdfToImages, pdfToText } from '../../pdf/convert';
import { openPdf } from '../../pdf/pdfjs';
import { useStore } from '../../store';
import { Field, Modal } from '../ui';
import { PagesField, close, resolvePages } from './common';

export function ConvertDialog({ initial = 'docx' }: { initial?: 'docx' | 'images' | 'text' }) {
  const fileName = useStore((s) => s.fileName);
  const n = useStore((s) => s.pageSizes.length);
  const [format, setFormat] = useState(initial);
  const [imgFormat, setImgFormat] = useState<'png' | 'jpeg'>('png');
  const [dpi, setDpi] = useState(150);
  const [pages, setPages] = useState('');
  const s = useStore.getState;
  const base = baseName(fileName);

  const run = () =>
    s().run('Convertendo…', async () => {
      const baked = await s().bake();
      const view = await openPdf(baked);
      const progress = (f: number) => s().setBusy('Convertendo…', f);
      try {
        if (format === 'docx') {
          download(await pdfToDocx(view, progress), `${base}.docx`);
        } else if (format === 'text') {
          download(new Blob([await pdfToText(view, progress)], { type: 'text/plain;charset=utf-8' }), `${base}.txt`);
        } else {
          const r = await pdfToImages(view, resolvePages(pages, n), imgFormat, dpi, fileName, progress);
          download(r.blob, r.name);
        }
      } finally {
        void view.loadingTask.destroy();
      }
      close();
    });

  return (
    <Modal title="Exportar PDF" onClose={close} footer={<button className="primary" onClick={run}>Exportar</button>}>
      <div className="segmented">
        <button className={format === 'docx' ? 'active' : ''} onClick={() => setFormat('docx')}>Word (.docx)</button>
        <button className={format === 'images' ? 'active' : ''} onClick={() => setFormat('images')}>Imagens</button>
        <button className={format === 'text' ? 'active' : ''} onClick={() => setFormat('text')}>Texto (.txt)</button>
      </div>
      {format === 'docx' && (
        <p className="hint">Gera um documento do Word com o texto de cada página, preservando parágrafos e quebras de página. Layouts complexos (colunas, tabelas) são simplificados. Páginas escaneadas entram como imagem; rode o OCR antes para obter texto editável.</p>
      )}
      {format === 'text' && <p className="hint">Extrai todo o texto do documento, página por página.</p>}
      {format === 'images' && (
        <>
          <div className="grid2">
            <Field label="Formato">
              <select value={imgFormat} onChange={(e) => setImgFormat(e.target.value as 'png' | 'jpeg')}>
                <option value="png">PNG (sem perdas)</option>
                <option value="jpeg">JPG (menor)</option>
              </select>
            </Field>
            <Field label="Resolução">
              <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
                <option value={72}>72 dpi (tela)</option>
                <option value={150}>150 dpi</option>
                <option value={300}>300 dpi (impressão)</option>
              </select>
            </Field>
          </div>
          <PagesField value={pages} onChange={setPages} />
          <p className="hint">Várias páginas são entregues em um arquivo .zip.</p>
        </>
      )}
    </Modal>
  );
}

interface Img {
  file: File;
  url: string;
}

export function ImagesToPdfDialog() {
  const hasDoc = useStore((s) => !!s.bytes);
  const [items, setItems] = useState<Img[]>([]);
  const [size, setSize] = useState<'A4' | 'Letter' | 'fit'>('A4');
  const [margin, setMargin] = useState(20);
  const s = useStore.getState;

  useEffect(() => () => items.forEach((i) => URL.revokeObjectURL(i.url)), [items]);

  const add = async () => {
    const files = await pickFiles('image/*', true);
    setItems((old) => [...old, ...files.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  };
  const move = (i: number, d: number) =>
    setItems((old) => {
      const next = [...old];
      const [it] = next.splice(i, 1);
      next.splice(i + d, 0, it);
      return next;
    });

  const run = (open: boolean) =>
    s().run('Criando PDF…', async () => {
      if (!items.length) throw new Error('Adicione ao menos uma imagem.');
      const out = await imagesToPdf(items.map((i) => i.file), size, size === 'fit' ? 0 : margin);
      const name = `${baseName(items[0].file.name)}.pdf`;
      if (open) {
        if (hasDoc && !window.confirm('Isso vai fechar o documento atual. Continuar?')) return;
        await s().load(out, name);
      } else download(out, name);
      close();
    });

  return (
    <Modal title="Imagens para PDF" onClose={close} wide
      footer={<><button onClick={() => run(false)}>Baixar PDF</button><button className="primary" onClick={() => run(true)}>Criar e abrir</button></>}>
      <p className="hint">Cada imagem vira uma página (JPG, PNG, WebP, GIF, BMP…). Ideal para fotos de documentos — depois, use o OCR para torná-las pesquisáveis.</p>
      <div className="image-grid">
        {items.map((it, i) => (
          <figure key={it.url}>
            <img src={it.url} alt={it.file.name} />
            <figcaption>
              <button className="icon" disabled={i === 0} onClick={() => move(i, -1)} title="Antes"><ArrowUp size={14} /></button>
              <button className="icon" disabled={i === items.length - 1} onClick={() => move(i, 1)} title="Depois"><ArrowDown size={14} /></button>
              <button className="icon" onClick={() => setItems((o) => o.filter((_, k) => k !== i))} title="Remover"><X size={14} /></button>
            </figcaption>
          </figure>
        ))}
        <button className="add-tile" onClick={add}><ImagePlus size={28} /> Adicionar imagens</button>
      </div>
      <div className="grid2">
        <Field label="Tamanho da página">
          <select value={size} onChange={(e) => setSize(e.target.value as typeof size)}>
            <option value="A4">A4</option>
            <option value="Letter">Carta</option>
            <option value="fit">Igual à imagem</option>
          </select>
        </Field>
        {size !== 'fit' && <Field label="Margem (pt)"><input type="number" min={0} max={150} value={margin} onChange={(e) => setMargin(Number(e.target.value))} /></Field>}
      </div>
    </Modal>
  );
}

export function CompareDialog() {
  const hasDoc = useStore((s) => !!s.bytes);
  const fileName = useStore((s) => s.fileName);
  const [diffs, setDiffs] = useState<PageDiff[] | null>(null);
  const [names, setNames] = useState<[string, string]>(['', '']);
  const s = useStore.getState;

  const run = async () => {
    const pick = async (label: string) => {
      s().toast(label);
      const [f] = await pickFiles('application/pdf,.pdf');
      if (!f) return null;
      const r = await readPdfFile(f);
      return r ? { name: f.name, bytes: r.bytes } : null;
    };
    const a = hasDoc ? { name: fileName, bytes: await s().bake() } : await pick('Escolha o documento ORIGINAL.');
    if (!a) return;
    const b = await pick('Escolha a versão para comparar.');
    if (!b) return;
    await s().run('Comparando…', async () => {
      const [va, vb] = await Promise.all([openPdf(a.bytes), openPdf(b.bytes)]);
      try {
        setDiffs(await compareDocuments(va, vb));
        setNames([a.name, b.name]);
      } finally {
        void va.loadingTask.destroy();
        void vb.loadingTask.destroy();
      }
    });
  };

  const changed = diffs?.filter((d) => d.added || d.removed) ?? [];
  return (
    <Modal title="Comparar documentos" onClose={close} wide footer={<button className="primary" onClick={run}>{diffs ? 'Comparar outros' : 'Escolher arquivo…'}</button>}>
      {!diffs && (
        <p className="hint">
          Compara o texto de duas versões, página por página, destacando o que foi incluído e removido.
          {hasDoc ? ` O documento aberto (${fileName}) é o original; escolha a outra versão.` : ' Você vai escolher os dois arquivos.'}
        </p>
      )}
      {diffs && (
        <>
          <p className="hint">
            <del>{names[0]}</del> → <ins>{names[1]}</ins>:{' '}
            {changed.length ? `${changed.length} página(s) com diferenças.` : 'nenhuma diferença de texto encontrada.'}
          </p>
          <div className="diff">
            {changed.map((d) => (
              <section key={d.page}>
                <h4>Página {d.page + 1} <small>+{d.added} / −{d.removed} palavras</small></h4>
                <p>
                  {d.changes.map((c, i) =>
                    c.added ? <ins key={i}>{c.value}</ins> : c.removed ? <del key={i}>{c.value}</del> : <span key={i}>{c.value.length > 300 ? c.value.slice(0, 120) + ' … ' + c.value.slice(-120) : c.value}</span>,
                  )}
                </p>
              </section>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
