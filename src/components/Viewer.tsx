import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { PageView } from './PageView';

const GAP = 16;

export function Viewer() {
  const pageSizes = useStore((s) => s.pageSizes);
  const zoom = useStore((s) => s.zoom);
  const tool = useStore((s) => s.tool);
  const scrollRequest = useStore((s) => s.scrollRequest);
  const ref = useRef<HTMLDivElement>(null);

  // Página atual = a que ocupa o centro da área visível.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const mid = el.scrollTop + el.clientHeight / 2;
      const children = el.querySelectorAll<HTMLElement>('[data-page]');
      for (const c of children) {
        if (c.offsetTop + c.offsetHeight + GAP / 2 >= mid) {
          useStore.getState().setCurrentPage(Number(c.dataset.page));
          break;
        }
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!scrollRequest) return;
    const target = ref.current?.querySelector<HTMLElement>(`[data-page="${scrollRequest.page}"]`);
    if (target && ref.current) ref.current.scrollTop = target.offsetTop - GAP;
  }, [scrollRequest]);

  // Ctrl + roda do mouse = zoom, mantendo a posição relativa.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const s = useStore.getState();
      const ratio = el.scrollTop / Math.max(1, el.scrollHeight);
      s.setZoom(s.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      requestAnimationFrame(() => (el.scrollTop = ratio * el.scrollHeight));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Ferramenta "mão": arrastar para rolar.
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (tool !== 'hand' || !ref.current) return;
    drag.current = { x: e.clientX, y: e.clientY, left: ref.current.scrollLeft, top: ref.current.scrollTop };
    ref.current.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !ref.current) return;
    ref.current.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
    ref.current.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const onPointerUp = () => (drag.current = null);

  return (
    <div
      className={`viewer tool-${tool}`}
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="pages" style={{ gap: GAP, padding: GAP }}>
        {pageSizes.map((size, i) => (
          <PageView key={i} index={i} width={size.w * zoom} height={size.h * zoom} />
        ))}
      </div>
    </div>
  );
}
