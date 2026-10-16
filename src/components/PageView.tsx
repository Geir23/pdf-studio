import { useEffect, useRef, useState } from 'react';
import { pdfjs } from '../pdf/pdfjs';
import { useStore } from '../store';
import { Overlay, finishEditing } from './Overlay';

interface Props {
  index: number;
  width: number;
  height: number;
}

interface PageLink {
  left: number;
  top: number;
  width: number;
  height: number;
  url?: string;
  dest?: unknown;
}

async function goToDest(dest: unknown) {
  const view = useStore.getState().view;
  if (!view || !dest) return;
  const explicit = typeof dest === 'string' ? await view.getDestination(dest) : (dest as unknown[]);
  const ref = explicit?.[0];
  if (ref == null) return;
  const index = typeof ref === 'number' ? ref : await view.getPageIndex(ref as never);
  useStore.getState().goToPage(index);
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
  const [links, setLinks] = useState<PageLink[]>([]);

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
        const annots = await page.getAnnotations();
        if (!cancelled) {
          const found: PageLink[] = [];
          for (const a of annots) {
            if (a.subtype !== 'Link' || (!a.url && !a.dest)) continue;
            const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
            const [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
            found.push({ left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), url: a.url, dest: a.dest });
          }
          setLinks(found);
        }
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
      {links.map((l, i) => (
        <a
          key={i}
          className="pdf-link"
          style={{ left: l.left, top: l.top, width: l.width, height: l.height }}
          href={l.url ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          title={l.url ?? 'Ir para a página'}
          onClick={(e) => {
            if (l.url) return;
            e.preventDefault();
            void goToDest(l.dest);
          }}
        />
      ))}
      <Overlay page={index} />
      <div className="page-number">{index + 1}</div>
    </div>
  );
}
