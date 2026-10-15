import { useStore } from '../store';
import { download } from './bytes';

type SaveHandle = { createWritable(): Promise<{ write(d: BlobPart): Promise<void>; close(): Promise<void> }> };
type SavePicker = (opts: unknown) => Promise<SaveHandle>;

let handle: { fileName: string; h: SaveHandle } | null = null;

/** Salva o documento. No Chrome/Edge grava no arquivo escolhido; nos demais, baixa uma cópia. */
export async function saveDocument(saveAs = false) {
  const s = useStore.getState();
  if (!s.bytes) return;
  await s.run('Salvando…', async () => {
    const bytes = await s.exportBytes();
    const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    if (picker) {
      try {
        if (!handle || handle.fileName !== s.fileName || saveAs) {
          handle = {
            fileName: s.fileName,
            h: await picker({
              suggestedName: s.fileName || 'documento.pdf',
              types: [{ description: 'Documento PDF', accept: { 'application/pdf': ['.pdf'] } }],
            }),
          };
        }
        const w = await handle.h.createWritable();
        await w.write(bytes as BlobPart);
        await w.close();
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        throw e;
      }
    } else {
      download(bytes, s.fileName || 'documento.pdf');
    }
    s.markSaved();
    s.toast('Documento salvo.', 'success');
  });
}

export async function printDocument() {
  const s = useStore.getState();
  if (!s.bytes) return;
  await s.run('Preparando impressão…', async () => {
    const bytes = s.objects.length ? await s.bake() : s.bytes!;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    frame.src = url;
    document.body.appendChild(frame);
    await new Promise<void>((resolve) => (frame.onload = () => resolve()));
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  });
}
