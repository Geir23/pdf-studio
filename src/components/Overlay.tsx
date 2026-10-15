import { MessageSquare } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CSS_FONT, LINE_HEIGHT } from '../pdf/fonts';
import { getTextBoxes, linesInRect, type TextBox } from '../pdf/textBoxes';
import { hasBox, newId, type Box, type EditObject, type TextObject } from '../pdf/types';
import { imageFileToDataUrl, pickFiles } from '../lib/files';
import { useStore, type Tool } from '../store';

type Pt = { x: number; y: number };

type Gesture =
  | { kind: 'create'; tool: Tool; start: Pt; current: Pt }
  | { kind: 'ink'; points: [number, number][] }
  | { kind: 'move'; id: string; start: Pt; orig: EditObject }
  | { kind: 'resize'; id: string; handle: string; start: Pt; orig: EditObject };

const DRAG_TOOLS: Tool[] = ['rect', 'ellipse', 'line', 'arrow', 'highlight', 'underline', 'strike', 'whiteout', 'redact', 'digitalSignature'];

function rectFrom(a: Pt, b: Pt): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function moved(o: EditObject, dx: number, dy: number): Partial<EditObject> {
  if ('x1' in o) return { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
  if (o.kind === 'ink') return { points: o.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
  return { x: o.x + dx, y: o.y + dy } as Partial<EditObject>;
}

function resized(o: EditObject, handle: string, dx: number, dy: number, keepRatio: boolean): Partial<EditObject> {
  if (o.kind === 'line' || o.kind === 'arrow') {
    return handle === 'p1' ? { x1: o.x1 + dx, y1: o.y1 + dy } : { x2: o.x2 + dx, y2: o.y2 + dy };
  }
  if (!hasBox(o)) return {};
  let { x, y, w, h } = o;
  if (handle.includes('w')) { x += dx; w -= dx; }
  if (handle.includes('e')) w += dx;
  if (handle.includes('n')) { y += dy; h -= dy; }
  if (handle.includes('s')) h += dy;
  if (keepRatio && o.w > 0 && o.h > 0) {
    const ratio = o.w / o.h;
    const nh = w / ratio;
    if (handle.includes('n')) y += h - nh;
    h = nh;
  }
  const min = 6;
  if (w < min) { if (handle.includes('w')) x -= min - w; w = min; }
  if (h < min) { if (handle.includes('n')) y -= min - h; h = min; }
  return { x, y, w, h } as Partial<EditObject>;
}

/** Encerra a edição de texto/comentário, descartando caixas que ficaram vazias. */
export function finishEditing() {
  const s = useStore.getState();
  const editing = s.objects.find((o) => o.id === s.editingId);
  if (editing && ((editing.kind === 'text' && !editing.text.trim() && !editing.bg) || (editing.kind === 'note' && !editing.text.trim()))) {
    s.removeObject(editing.id);
  }
  s.setEditing(null);
}

export function Overlay({ page }: { page: number }) {
  const zoom = useStore((s) => s.zoom);
  const tool = useStore((s) => s.tool);
  const objects = useStore((s) => s.objects);
  const selectedId = useStore((s) => s.selectedId);
  const editingId = useStore((s) => s.editingId);
  const style = useStore((s) => s.style);
  const view = useStore((s) => s.view);
  const size = useStore((s) => s.pageSizes[page]);
  const ref = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [textBoxes, setTextBoxes] = useState<TextBox[]>([]);

  const mine = objects.filter((o) => o.page === page);
  const needsText = tool === 'editText' || tool === 'highlight' || tool === 'underline' || tool === 'strike';

  useEffect(() => {
    if (!needsText || !view) return;
    let alive = true;
    getTextBoxes(view, page).then((b) => alive && setTextBoxes(b));
    return () => {
      alive = false;
    };
  }, [needsText, view, page]);

  if (!size) return null;

  const pt = (e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  };

  const store = useStore.getState;

  const onPointerDown = async (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = pt(e);
    const s = store();
    if (s.editingId) {
      finishEditing();
      if (tool === 'text' || tool === 'note' || tool === 'editText') return;
    }
    if (tool === 'select' || tool === 'hand') {
      s.select(null);
      return;
    }
    e.preventDefault();
    if (DRAG_TOOLS.includes(tool)) {
      ref.current!.setPointerCapture(e.pointerId);
      setGesture({ kind: 'create', tool, start: p, current: p });
      return;
    }
    if (tool === 'ink') {
      ref.current!.setPointerCapture(e.pointerId);
      setGesture({ kind: 'ink', points: [[p.x, p.y]] });
      return;
    }
    if (tool === 'text') {
      const o: TextObject = {
        id: newId(), page, kind: 'text', x: p.x, y: p.y - style.fontSize * 0.6, w: 220, h: style.fontSize * LINE_HEIGHT + 4,
        text: '', size: style.fontSize, color: style.color, font: style.font, bold: style.bold, italic: style.italic, bg: null,
      };
      s.addObject(o);
      s.setEditing(o.id);
      return;
    }
    if (tool === 'note') {
      const o: EditObject = { id: newId(), page, kind: 'note', x: p.x - 10, y: p.y - 10, text: '', color: '#f9a825', author: localStorage.getItem('pdfstudio.author') ?? '' };
      s.addObject(o);
      s.setEditing(o.id);
      return;
    }
    if (tool === 'image') {
      const [file] = await pickFiles('image/*');
      if (!file) return;
      const img = await imageFileToDataUrl(file);
      const w = Math.min(img.w * 0.75, 300, size.w - p.x);
      const h = (w * img.h) / img.w;
      s.addObject({ id: newId(), page, kind: 'image', x: p.x, y: p.y, w, h, dataUrl: img.dataUrl, opacity: 1 });
      s.setTool('select');
      return;
    }
    if (tool === 'signature' && s.pendingSignature) {
      const w = 160;
      const h = w / s.pendingSignature.ratio;
      s.addObject({ id: newId(), page, kind: 'image', x: p.x - w / 2, y: p.y - h / 2, w, h, dataUrl: s.pendingSignature.dataUrl, opacity: 1 });
      s.setTool('select');
      store().select(store().objects[store().objects.length - 1].id);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!gesture) return;
    const p = pt(e);
    if (gesture.kind === 'create') setGesture({ ...gesture, current: p });
    else if (gesture.kind === 'ink') setGesture({ kind: 'ink', points: [...gesture.points, [p.x, p.y]] });
    else {
      const dx = p.x - gesture.start.x;
      const dy = p.y - gesture.start.y;
      const patch =
        gesture.kind === 'move'
          ? moved(gesture.orig, dx, dy)
          : resized(gesture.orig, gesture.handle, dx, dy, gesture.orig.kind === 'image' || e.shiftKey);
      store().updateObject(gesture.id, patch);
    }
  };

  const onPointerUp = () => {
    const g = gesture;
    setGesture(null);
    if (!g) return;
    const s = store();
    if (g.kind === 'ink') {
      if (g.points.length > 1) {
        s.addObject({ id: newId(), page, kind: 'ink', points: g.points, stroke: style.color, width: style.width, opacity: style.opacity });
      }
      return;
    }
    if (g.kind !== 'create') return;
    const r = rectFrom(g.start, g.current);
    const tiny = r.w < 4 && r.h < 4;
    switch (g.tool) {
      case 'rect':
      case 'ellipse':
        if (!tiny) s.addObject({ id: newId(), page, kind: g.tool, ...r, stroke: style.color, fill: style.fill, width: style.width, opacity: style.opacity });
        break;
      case 'line':
      case 'arrow':
        if (!tiny) s.addObject({ id: newId(), page, kind: g.tool, x1: g.start.x, y1: g.start.y, x2: g.current.x, y2: g.current.y, stroke: style.color, width: style.width, opacity: style.opacity });
        break;
      case 'highlight':
      case 'underline':
      case 'strike': {
        const lines = linesInRect(textBoxes, tiny ? { x: g.start.x - 1, y: g.start.y - 1, w: 2, h: 2 } : r);
        const color = g.tool === 'highlight' ? style.highlight : style.color;
        const rects = lines.length ? lines : tiny ? [] : [r];
        if (rects.length) s.checkpoint('Marcação');
        for (const box of rects) {
          useStore.setState((st) => ({ objects: [...st.objects, { id: newId(), page, kind: g.tool as 'highlight', ...box, color }] }));
        }
        break;
      }
      case 'whiteout':
        if (!tiny) s.addObject({ id: newId(), page, kind: 'whiteout', ...r, color: '#ffffff' });
        break;
      case 'redact':
        if (!tiny) s.addObject({ id: newId(), page, kind: 'redact', ...r, color: '#000000' });
        break;
      case 'digitalSignature':
        if (r.w < 40 || r.h < 20) {
          s.toast('Desenhe um retângulo maior para a assinatura.');
          break;
        }
        s.setPendingDigitalBox({ page, box: r });
        s.openDialog('digitalSign');
        break;
    }
  };

  const startEditText = (b: TextBox) => {
    const s = store();
    const pad = 1.5;
    const cover = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
    const o: TextObject = {
      id: newId(), page, kind: 'text', ...cover, text: b.str, size: Math.round(b.size * 10) / 10, color: '#000000',
      font: b.font, bold: false, italic: false, bg: '#ffffff', cover, nowrap: true,
    };
    s.addObject(o);
    s.setEditing(o.id);
  };

  const startMove = (e: React.PointerEvent, o: EditObject) => {
    if (tool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    if (editingId === o.id) return;
    const s = store();
    if (s.editingId) finishEditing();
    s.select(o.id);
    s.checkpoint('Mover');
    ref.current!.setPointerCapture(e.pointerId);
    setGesture({ kind: 'move', id: o.id, start: pt(e), orig: o });
  };

  const startResize = (e: React.PointerEvent, o: EditObject, handle: string) => {
    e.stopPropagation();
    store().checkpoint('Redimensionar');
    ref.current!.setPointerCapture(e.pointerId);
    setGesture({ kind: 'resize', id: o.id, handle, start: pt(e), orig: o });
  };

  const interactive = tool !== 'select' && tool !== 'hand';
  const preview = gesture?.kind === 'create' ? rectFrom(gesture.start, gesture.current) : null;

  return (
    <div
      ref={ref}
      className={`overlay ${interactive ? 'capture' : ''}`}
      style={{ width: size.w, height: size.h, transform: `scale(${zoom})`, '--zoom': zoom } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg className="vector" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
        {mine.map((o) => {
          if (o.kind === 'line' || o.kind === 'arrow') {
            const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
            const len = Math.max(8, o.width * 4);
            const head = [-1, 1].map((side) => {
              const a = ang + Math.PI - side * (Math.PI / 7);
              return `M${o.x2},${o.y2} L${o.x2 + Math.cos(a) * len},${o.y2 + Math.sin(a) * len}`;
            });
            return (
              <g key={o.id} className="obj" opacity={o.opacity} onPointerDown={(e) => startMove(e, o)}>
                <path d={`M${o.x1},${o.y1} L${o.x2},${o.y2}`} stroke="transparent" strokeWidth={Math.max(10, o.width + 8)} />
                <path d={`M${o.x1},${o.y1} L${o.x2},${o.y2} ${o.kind === 'arrow' ? head.join(' ') : ''}`} stroke={o.stroke} strokeWidth={o.width} strokeLinecap="round" fill="none" />
              </g>
            );
          }
          if (o.kind === 'ink') {
            const d = o.points.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
            return (
              <g key={o.id} className="obj" opacity={o.opacity} onPointerDown={(e) => startMove(e, o)}>
                <path d={d} stroke="transparent" strokeWidth={Math.max(10, o.width + 8)} fill="none" />
                <path d={d} stroke={o.stroke} strokeWidth={o.width} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </g>
            );
          }
          if (o.kind === 'ellipse' || o.kind === 'rect') {
            const sw = o.stroke ? o.width : 0;
            const common = { stroke: o.stroke ?? 'none', strokeWidth: sw, fill: o.fill ?? 'transparent', opacity: o.opacity };
            return (
              <g key={o.id} className="obj" onPointerDown={(e) => startMove(e, o)}>
                {o.kind === 'rect' ? (
                  <rect x={o.x + sw / 2} y={o.y + sw / 2} width={Math.max(0, o.w - sw)} height={Math.max(0, o.h - sw)} {...common} />
                ) : (
                  <ellipse cx={o.x + o.w / 2} cy={o.y + o.h / 2} rx={o.w / 2} ry={o.h / 2} {...common} />
                )}
              </g>
            );
          }
          return null;
        })}
        {gesture?.kind === 'ink' && (
          <path d={gesture.points.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ')} stroke={style.color} strokeWidth={style.width} opacity={style.opacity} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {gesture?.kind === 'create' && (gesture.tool === 'line' || gesture.tool === 'arrow') && (
          <line x1={gesture.start.x} y1={gesture.start.y} x2={gesture.current.x} y2={gesture.current.y} stroke={style.color} strokeWidth={style.width} />
        )}
      </svg>

      {mine.map((o) => {
        if (!hasBox(o) || o.kind === 'rect' || o.kind === 'ellipse') return null;
        const pos = { left: o.x, top: o.y, width: o.w, height: o.h };
        switch (o.kind) {
          case 'text':
            return (<Fragment key={o.id}>
              {o.cover && o.bg && <div className="cover-bg" style={{ left: o.cover.x, top: o.cover.y, width: o.cover.w, height: o.cover.h, background: o.bg }} />}
              <TextEl o={o} editing={editingId === o.id} pos={pos}
                onPointerDown={(e) => startMove(e, o)}
                onDoubleClick={() => store().setEditing(o.id)}
                onDone={finishEditing} />
            </Fragment>);
          case 'image':
            return <img key={o.id} className="obj" src={o.dataUrl} style={{ ...pos, opacity: o.opacity }} draggable={false} onPointerDown={(e) => startMove(e, o)} alt="" />;
          case 'highlight':
            return <div key={o.id} className="obj markup" style={{ ...pos, background: o.color }} onPointerDown={(e) => startMove(e, o)} />;
          case 'underline':
          case 'strike':
            return (
              <div key={o.id} className="obj" style={pos} onPointerDown={(e) => startMove(e, o)}>
                <div style={{ position: 'absolute', left: 0, right: 0, top: o.kind === 'underline' ? o.h - 1.5 : o.h / 2, height: Math.max(1, o.h / 12), background: o.color }} />
              </div>
            );
          case 'whiteout':
            return <div key={o.id} className="obj cover" style={{ ...pos, background: o.color }} onPointerDown={(e) => startMove(e, o)} />;
          case 'redact':
            return <div key={o.id} className="obj redact" style={pos} title="Área a redigir (removida ao salvar)" onPointerDown={(e) => startMove(e, o)} />;
        }
        return null;
      })}

      {mine.map((o) =>
        o.kind === 'note' ? (
          <div key={o.id} className="note-wrap" style={{ left: o.x, top: o.y }}>
            <div className="obj note-icon" style={{ color: o.color }} onPointerDown={(e) => startMove(e, o)} onDoubleClick={() => store().setEditing(o.id)} title={o.text}>
              <MessageSquare size={20} fill="currentColor" stroke="#5d4300" />
            </div>
            {(editingId === o.id || selectedId === o.id) && (
              <div className="note-popup" onPointerDown={(e) => e.stopPropagation()}>
                <input
                  placeholder="Autor"
                  value={o.author}
                  onChange={(e) => {
                    localStorage.setItem('pdfstudio.author', e.target.value);
                    store().updateObject(o.id, { author: e.target.value });
                  }}
                />
                <textarea
                  autoFocus={editingId === o.id}
                  placeholder="Escreva o comentário…"
                  value={o.text}
                  onChange={(e) => store().updateObject(o.id, { text: e.target.value })}
                />
              </div>
            )}
          </div>
        ) : null,
      )}

      {tool === 'editText' &&
        textBoxes.map((b, i) => (
          <div key={i} className="text-target" style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
            onPointerDown={(e) => {
              // Sem preventDefault o navegador tira o foco da caixa de edição recém-criada.
              e.preventDefault();
              e.stopPropagation();
              if (store().editingId) finishEditing();
              startEditText(b);
            }} />
        ))}

      {preview && gesture?.kind === 'create' && gesture.tool !== 'line' && gesture.tool !== 'arrow' && (
        <div className={`preview preview-${gesture.tool}`} style={{ left: preview.x, top: preview.y, width: preview.w, height: preview.h,
          borderColor: style.color, borderRadius: gesture.tool === 'ellipse' ? '50%' : undefined }} />
      )}

      {selectedId && tool === 'select' && <Selection o={mine.find((o) => o.id === selectedId)} startResize={startResize} />}
    </div>
  );
}

let canvasCtx: CanvasRenderingContext2D | null = null;
function measureCtx() {
  return (canvasCtx ??= document.createElement('canvas').getContext('2d')!);
}

function TextEl(props: {
  o: TextObject;
  editing: boolean;
  pos: React.CSSProperties;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
  onDone: () => void;
}) {
  const { o, editing } = props;
  const ta = useRef<HTMLTextAreaElement>(null);
  const css: React.CSSProperties = {
    ...props.pos,
    fontFamily: CSS_FONT[o.font],
    fontSize: o.size,
    lineHeight: LINE_HEIGHT,
    color: o.color,
    fontWeight: o.bold ? 700 : 400,
    fontStyle: o.italic ? 'italic' : 'normal',
    background: o.bg ?? 'transparent',
    whiteSpace: o.nowrap ? 'pre' : 'pre-wrap',
  };
  // Foco síncrono (antes da próxima pintura) para nenhuma tecla escapar da caixa.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!editing || !el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  const grow = (el: HTMLTextAreaElement, text: string) => {
    if (o.nowrap) {
      // Mede com as mesmas métricas da fonte para a caixa acompanhar o texto.
      const ctx = measureCtx();
      ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? '700 ' : ''}${o.size}px ${CSS_FONT[o.font]}`;
      const lines = text.split('\n');
      const w = Math.max(o.cover?.w ?? 0, ...lines.map((l) => ctx.measureText(l).width + 4));
      const h = Math.max(o.cover?.h ?? 0, lines.length * o.size * LINE_HEIGHT + 3);
      useStore.getState().updateObject(o.id, { w, h });
      return;
    }
    if (el.scrollHeight > el.clientHeight + 1) useStore.getState().updateObject(o.id, { h: el.scrollHeight + 2 });
  };
  if (editing) {
    return (
      <textarea
        ref={ta}
        className="obj text-obj editing"
        style={css}
        value={o.text}
        spellCheck
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          useStore.getState().updateObject(o.id, { text: e.target.value });
          grow(e.target, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onDone();
          e.stopPropagation();
        }}
      />
    );
  }
  return (
    <div className="obj text-obj" style={css} onPointerDown={props.onPointerDown} onDoubleClick={props.onDoubleClick}>
      {o.text || <span className="placeholder">Texto</span>}
    </div>
  );
}

function Selection({ o, startResize }: { o?: EditObject; startResize: (e: React.PointerEvent, o: EditObject, h: string) => void }) {
  if (!o) return null;
  if ('x1' in o) {
    return (
      <>
        {(['p1', 'p2'] as const).map((h) => (
          <div key={h} className="handle" style={{ left: h === 'p1' ? o.x1 : o.x2, top: h === 'p1' ? o.y1 : o.y2 }} onPointerDown={(e) => startResize(e, o, h)} />
        ))}
      </>
    );
  }
  let box: Box;
  if (o.kind === 'ink') {
    const xs = o.points.map((p) => p[0]);
    const ys = o.points.map((p) => p[1]);
    box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  } else if (hasBox(o)) {
    box = o;
  } else {
    box = { x: o.x, y: o.y, w: 20, h: 20 };
  }
  const resizable = hasBox(o);
  return (
    <div className="selection" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
      {resizable &&
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => (
          <div key={h} className={`handle h-${h}`} onPointerDown={(e) => startResize(e, o, h)} />
        ))}
    </div>
  );
}
