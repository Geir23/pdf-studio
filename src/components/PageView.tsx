import { useEffect, useRef, useState } from 'react';
import { pdfjs } from '../pdf/pdfjs';
import { useStore } from '../store';
import { Overlay, finishEditing } from './Overlay';

interface Props {
  index: number;
  width: number;
  height: number;
}

function normalize(s: string) {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Envolve as ocorrências da busca em <mark> dentro dos spans da camada de texto. */
function highlightMatches(container: HTMLElement, query: string) {
  const q = normalize(query);
  if (!q) return;
  for (const span of container.querySelectorAll<HTMLSpanElement>('span:not(:has(span))')) {
    const text = span.textContent ?? '';
    const n = normalize(text);
    if (n.length !== text.length || !n.includes(q)) continue;
    let html = '';
    let i = 0;
    for (let at = n.indexOf(q); at !== -1; at = n.indexOf(q, i)) {
      html += escapeHtml(text.slice(i, at)) + `<mark>${escapeHtml(text.slice(at, at + q.length))}</mark>`;
      i = at + q.length;
    }
    span.innerHTML = html + escapeHtml(text.slice(i));
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function PageView({ index, width, height }: Props) {
  const view = useStore((s) => s.view);
  const version = useStore((s) => s.version);
  const zoom = useStore((s) => s.zoom);
  const highlight = useStore((s) => (s.searchHighlight?.page === index ? s.searchHighlight.query : null));
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: el.closest('.viewer'),
      rootMargin: '600px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Desenha a página (com um pequeno atraso durante mudanças de zoom).
  useEffect(() => {
    if (!visible || !view) return;
    let cancelled = false;
    let task: ReturnType<pdfjs.PDFPageProxy['render']> | null = null;
    let textLayer: pdfjs.TextLayer | null = null;
    const timer = setTimeout(async () => {
      try {
        const page = await view.getPage(index + 1);
        if (cancelled) return;
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: zoom });
        const canvas = canvasRef.current!;
        const offscreen = document.createElement('canvas');
        offscreen.width = Math.floor(viewport.width * dpr);
        offscreen.height = Math.floor(viewport.height * dpr);
        const ctx = offscreen.getContext('2d')!;
        task = page.render({
          canvasContext: ctx,
          canvas: offscreen,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        await task.promise;
        if (cancelled) return;
        canvas.width = offscreen.width;
        canvas.height = offscreen.height;
        canvas.getContext('2d')!.drawImage(offscreen, 0, 0);
        setRendered(true);

        const container = textRef.current!;
        container.replaceChildren();
        textLayer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container,
          viewport,
        });
        await textLayer.render();
        if (!cancelled && highlight) highlightMatches(container, highlight);
      } catch (e) {
        if (!(e instanceof pdfjs.RenderingCancelledException)) console.error(e);
      }
    }, rendered ? 120 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
      textLayer?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, view, version, zoom, index, highlight]);

  return (
    <div
      className="page"
      data-page={index}
      ref={ref}
      style={{ width, height }}
      onPointerDown={(e) => {
        const s = useStore.getState();
        if (s.tool !== 'select' || (e.target as HTMLElement).closest('.obj, .handle, .note-popup')) return;
        if (s.editingId) finishEditing();
        else s.select(null);
      }}
    >
      <canvas ref={canvasRef} style={{ width, height }} className={rendered ? '' : 'loading'} />
      <div
        ref={textRef}
        className="textLayer"
        style={
          {
            '--total-scale-factor': zoom,
            '--scale-factor': zoom,
            '--scale-round-x': '1px',
            '--scale-round-y': '1px',
          } as React.CSSProperties
        }
      />
      <Overlay page={index} />
      <div className="page-number">{index + 1}</div>
    </div>
  );
}
