import { parseRanges } from '../../pdf/pages';
import { useStore } from '../../store';
import { Field } from '../ui';

/** "" ou "todas" = todas as páginas. */
export function resolvePages(input: string, pageCount: number): number[] {
  const t = input.trim().toLowerCase();
  if (!t || t === 'todas') return Array.from({ length: pageCount }, (_, i) => i);
  return parseRanges(input, pageCount);
}

export function PagesField({ value, onChange, label = 'Páginas' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const n = useStore((s) => s.pageSizes.length);
  return (
    <Field label={label} hint={`Ex.: 1-3, 5, 8- (o documento tem ${n} página${n === 1 ? '' : 's'}). Vazio = todas.`}>
      <input value={value} placeholder="todas" onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export const close = () => useStore.getState().openDialog(null);
