import { create } from 'zustand';
import { PDFDocument, PDFSignature } from 'pdf-lib';
import { flattenObjects } from './pdf/flatten';
import { openPdf, type PDFDocumentProxy } from './pdf/pdfjs';
import { rasterizePages } from './pdf/render';
import { encryptPdf, type ProtectOptions } from './pdf/tools';
import type { Box, EditObject, FieldType, FontFamily } from './pdf/types';

export type Tool =
  | 'select'
  | 'hand'
  | 'text'
  | 'editText'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'ink'
  | 'whiteout'
  | 'redact'
  | 'note'
  | 'image'
  | 'signature'
  | 'digitalSignature'
  | 'field'
  | 'link';

export interface ToolStyle {
  color: string; // traço / texto
  fill: string | null;
  highlight: string;
  width: number;
  opacity: number;
  fontSize: number;
  font: FontFamily;
  bold: boolean;
  italic: boolean;
  fieldType: FieldType;
}

interface Snapshot {
  bytes: Uint8Array;
  objects: EditObject[];
  label: string;
}

export interface PageSize {
  w: number;
  h: number;
}

interface Busy {
  message: string;
  progress: number | null;
}

interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

interface State {
  fileName: string;
  bytes: Uint8Array | null;
  view: PDFDocumentProxy | null;
  pageSizes: PageSize[];
  version: number;
  objects: EditObject[];
  past: Snapshot[];
  future: Snapshot[];
  dirty: boolean;
  security: ProtectOptions | null;
  /** O documento tem assinaturas digitais; regravar o arquivo as invalidaria. */
  signed: boolean;

  tool: Tool;
  style: ToolStyle;
  selectedId: string | null;
  editingId: string | null;
  zoom: number;
  currentPage: number;
  selectedPages: number[];
  /** Imagem da assinatura escolhida, aguardando ser posicionada. */
  pendingSignature: { dataUrl: string; ratio: number } | null;
  /** Área desenhada para a assinatura digital, aguardando o certificado. */
  pendingDigitalBox: { page: number; box: Box } | null;
  searchHighlight: { page: number; query: string } | null;
  scrollRequest: { page: number; nonce: number } | null;
  dialog: string | null;
  busy: Busy | null;
  toasts: Toast[];
}

interface Actions {
  load(bytes: Uint8Array, fileName: string, opts?: { security?: ProtectOptions | null }): Promise<void>;
  close(): void;
  /** Aplica uma operação que gera novos bytes. Edições pendentes são gravadas antes. */
  apply(label: string, op: (bytes: Uint8Array) => Promise<Uint8Array>, opts?: { allowOnSigned?: boolean }): Promise<boolean>;
  /** Grava os objetos pendentes no PDF e devolve os bytes resultantes. */
  bake(): Promise<Uint8Array>;
  exportBytes(): Promise<Uint8Array>;
  markSaved(): void;

  checkpoint(label: string): void;
  addObject(o: EditObject): void;
  updateObject(id: string, patch: Partial<EditObject>, record?: boolean): void;
  removeObject(id: string): void;
  undo(): Promise<void>;
  redo(): Promise<void>;

  setTool(t: Tool): void;
  setStyle(patch: Partial<ToolStyle>): void;
  select(id: string | null): void;
  setEditing(id: string | null): void;
  setZoom(z: number): void;
  setCurrentPage(p: number): void;
  goToPage(p: number): void;
  setSelectedPages(p: number[]): void;
  setSecurity(s: ProtectOptions | null): void;
  setPendingSignature(v: { dataUrl: string; ratio: number } | null): void;
  setPendingDigitalBox(v: { page: number; box: Box } | null): void;
  setSearchHighlight(v: { page: number; query: string } | null): void;
  openDialog(name: string | null): void;
  setBusy(message: string | null, progress?: number | null): void;
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
  run<T>(message: string, fn: () => Promise<T>): Promise<T | undefined>;
}

export type Store = State & Actions;

const MAX_HISTORY = 30;
let toastId = 0;

async function detectSignatures(bytes: Uint8Array): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return doc
      .getForm()
      .getFields()
      .some((f) => f instanceof PDFSignature);
  } catch {
    return false;
  }
}

async function measurePages(view: PDFDocumentProxy): Promise<PageSize[]> {
  const sizes: PageSize[] = [];
  for (let i = 1; i <= view.numPages; i++) {
    const vp = (await view.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  return sizes;
}

export const useStore = create<Store>((set, get) => {
  /** Troca o documento exibido pelos novos bytes. */
  async function show(bytes: Uint8Array) {
    const view = await openPdf(bytes);
    const pageSizes = await measurePages(view);
    const old = get().view;
    set((s) => ({
      bytes,
      view,
      pageSizes,
      version: s.version + 1,
      currentPage: Math.min(s.currentPage, view.numPages - 1),
      selectedPages: s.selectedPages.filter((p) => p < view.numPages),
    }));
    void old?.loadingTask.destroy();
  }

  function snapshot(label: string): Snapshot {
    const s = get();
    return { bytes: s.bytes!, objects: s.objects, label };
  }

  function pushHistory(label: string) {
    set((s) => ({ past: [...s.past, snapshot(label)].slice(-MAX_HISTORY), future: [], dirty: true }));
  }

  async function bakeBytes(bytes: Uint8Array, objects: EditObject[]): Promise<Uint8Array> {
    if (objects.length === 0) return bytes;
    let out = await flattenObjects(bytes, objects);
    const redactions = new Map<number, Box[]>();
    for (const o of objects) {
      if (o.kind !== 'redact') continue;
      redactions.set(o.page, [...(redactions.get(o.page) ?? []), { x: o.x, y: o.y, w: o.w, h: o.h }]);
    }
    if (redactions.size) {
      // Redação segura: as páginas afetadas viram imagem, apagando o texto por baixo.
      const view = await openPdf(out);
      try {
        out = await rasterizePages(out, view, [...redactions.keys()], { dpi: 200, quality: 0.9, blackouts: redactions });
      } finally {
        void view.loadingTask.destroy();
      }
    }
    return out;
  }

  return {
    fileName: '',
    bytes: null,
    view: null,
    pageSizes: [],
    version: 0,
    objects: [],
    past: [],
    future: [],
    dirty: false,
    security: null,
    signed: false,
    tool: 'select',
    style: {
      color: '#d32f2f',
      fill: null,
      highlight: '#ffeb3b',
      width: 2,
      opacity: 1,
      fontSize: 14,
      font: 'Helvetica',
      bold: false,
      italic: false,
      fieldType: 'text',
    },
    selectedId: null,
    editingId: null,
    zoom: 1,
    currentPage: 0,
    selectedPages: [],
    pendingSignature: null,
    pendingDigitalBox: null,
    searchHighlight: null,
    scrollRequest: null,
    dialog: null,
    busy: null,
    toasts: [],

    async load(bytes, fileName, opts) {
      set({ currentPage: 0, selectedPages: [] });
      await show(bytes);
      set({
        fileName,
        objects: [],
        past: [],
        future: [],
        dirty: false,
        security: opts?.security ?? null,
        signed: await detectSignatures(bytes),
        selectedId: null,
        editingId: null,
        searchHighlight: null,
        zoom: 1,
      });
    },

    close() {
      void get().view?.loadingTask.destroy();
      set({ bytes: null, view: null, pageSizes: [], objects: [], past: [], future: [], fileName: '', dirty: false, signed: false, security: null });
    },

    async apply(label, op, opts) {
      const s = get();
      if (!s.bytes) return false;
      if (s.signed && !opts?.allowOnSigned) {
        const ok = window.confirm(
          'Este documento tem assinatura digital. Alterá-lo vai invalidar as assinaturas existentes. Continuar?',
        );
        if (!ok) return false;
      }
      const baked = await bakeBytes(s.bytes, s.objects);
      const next = await op(baked);
      pushHistory(label);
      set({ objects: [], selectedId: null, editingId: null });
      await show(next);
      if (!opts?.allowOnSigned) set({ signed: await detectSignatures(next) });
      return true;
    },

    async bake() {
      const s = get();
      return bakeBytes(s.bytes!, s.objects);
    },

    async exportBytes() {
      const s = get();
      if (!s.bytes) throw new Error('Nenhum documento aberto.');
      // Documento assinado sem edições novas: entrega os bytes exatos para não invalidar.
      if (s.signed && s.objects.length === 0) return s.bytes;
      let out = await bakeBytes(s.bytes, s.objects);
      if (s.security) out = await encryptPdf(out, s.security);
      return out;
    },

    markSaved() {
      set({ dirty: false });
    },

    checkpoint(label) {
      pushHistory(label);
    },

    addObject(o) {
      pushHistory('Adicionar');
      set((s) => ({ objects: [...s.objects, o], selectedId: o.id }));
    },

    updateObject(id, patch, record = false) {
      if (record) pushHistory('Editar');
      set((s) => ({
        objects: s.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as EditObject) : o)),
        dirty: true,
      }));
    },

    removeObject(id) {
      pushHistory('Excluir');
      set((s) => ({
        objects: s.objects.filter((o) => o.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId,
        editingId: s.editingId === id ? null : s.editingId,
      }));
    },

    async undo() {
      const s = get();
      const prev = s.past[s.past.length - 1];
      if (!prev) return;
      const current = snapshot(prev.label);
      set({ past: s.past.slice(0, -1), future: [current, ...s.future], objects: prev.objects, selectedId: null, editingId: null });
      if (prev.bytes !== s.bytes) await show(prev.bytes);
    },

    async redo() {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      const current = snapshot(next.label);
      set({ future: s.future.slice(1), past: [...s.past, current], objects: next.objects, selectedId: null, editingId: null });
      if (next.bytes !== s.bytes) await show(next.bytes);
    },

    setTool(tool) {
      set({ tool, selectedId: null, editingId: null });
    },
    setStyle(patch) {
      set((s) => ({ style: { ...s.style, ...patch } }));
    },
    select(selectedId) {
      set({ selectedId, editingId: null });
    },
    setEditing(editingId) {
      set({ editingId, selectedId: editingId ?? get().selectedId });
    },
    setZoom(z) {
      set({ zoom: Math.min(5, Math.max(0.25, Math.round(z * 100) / 100)) });
    },
    setCurrentPage(currentPage) {
      if (currentPage !== get().currentPage) set({ currentPage });
    },
    goToPage(page) {
      const n = get().view?.numPages ?? 0;
      const p = Math.min(Math.max(page, 0), Math.max(n - 1, 0));
      set({ currentPage: p, scrollRequest: { page: p, nonce: Date.now() } });
    },
    setSelectedPages(selectedPages) {
      set({ selectedPages });
    },
    setSecurity(security) {
      set({ security, dirty: true });
    },
    setPendingSignature(pendingSignature) {
      set({ pendingSignature, tool: pendingSignature ? 'signature' : get().tool });
    },
    setPendingDigitalBox(pendingDigitalBox) {
      set({ pendingDigitalBox });
    },
    setSearchHighlight(searchHighlight) {
      set({ searchHighlight });
    },
    openDialog(dialog) {
      set({ dialog });
    },
    setBusy(message, progress = null) {
      set({ busy: message === null ? null : { message, progress } });
    },
    toast(text, kind = 'info') {
      const id = ++toastId;
      set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000);
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    async run(message, fn) {
      get().setBusy(message);
      try {
        return await fn();
      } catch (e) {
        console.error(e);
        get().toast(e instanceof Error ? e.message : String(e), 'error');
        return undefined;
      } finally {
        get().setBusy(null);
      }
    },
  };
});
