import { Bold, Copy, Italic, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { newId, type EditObject, type FieldType, type FontFamily, type LinkObject } from '../pdf/types';
import { useStore, type Tool, type ToolStyle } from '../store';
import { ColorInput, Field } from './ui';

const TOOL_NAMES: Partial<Record<Tool, string>> = {
  text: 'Adicionar texto', editText: 'Editar texto', highlight: 'Destacar', underline: 'Sublinhar', strike: 'Tachar',
  ink: 'Desenho livre', rect: 'Retângulo', ellipse: 'Elipse', line: 'Linha', arrow: 'Seta', note: 'Comentário',
  whiteout: 'Apagar', redact: 'Redigir', image: 'Imagem', signature: 'Assinatura', digitalSignature: 'Assinatura digital',
  field: 'Criar campo de formulário', link: 'Criar link',
};

const TOOL_HELP: Partial<Record<Tool, string>> = {
  text: 'Clique na página para criar uma caixa de texto.',
  editText: 'Clique em um trecho de texto do documento para reescrevê-lo. O original é coberto e o novo texto é gravado no lugar.',
  highlight: 'Arraste sobre o texto para destacar.',
  underline: 'Arraste sobre o texto para sublinhar.',
  strike: 'Arraste sobre o texto para tachar.',
  ink: 'Desenhe livremente com o mouse, caneta ou dedo.',
  note: 'Clique onde quer deixar o comentário.',
  whiteout: 'Arraste para cobrir uma área com branco (o conteúdo continua no arquivo — para remover de verdade, use Redigir).',
  redact: 'Arraste sobre o conteúdo sigiloso. Ao salvar, a página vira imagem e o que estava sob a tarja é eliminado.',
  image: 'Clique na página onde a imagem deve ficar.',
  signature: 'Clique na página para posicionar a assinatura.',
  digitalSignature: 'Desenhe o retângulo onde a assinatura digital vai aparecer.',
  field: 'Escolha o tipo e clique ou arraste na página. Depois ajuste nome e opções aqui.',
  link: 'Arraste sobre a área que será clicável; depois informe o endereço ou a página de destino.',
};

const OBJ_NAMES: Record<EditObject['kind'], string> = {
  text: 'Texto', image: 'Imagem', rect: 'Retângulo', ellipse: 'Elipse', line: 'Linha', arrow: 'Seta', ink: 'Desenho',
  highlight: 'Destaque', underline: 'Sublinhado', strike: 'Tachado', whiteout: 'Cobertura branca', redact: 'Redação', note: 'Comentário',
  field: 'Campo de formulário', link: 'Link',
};

export function Properties() {
  const tool = useStore((s) => s.tool);
  const style = useStore((s) => s.style);
  const selected = useStore((s) => s.objects.find((o) => o.id === s.selectedId));
  const pendingCount = useStore((s) => s.objects.length);
  const s = useStore.getState;

  if (!selected && (tool === 'select' || tool === 'hand')) {
    return (
      <aside className="properties">
        <h3>Propriedades</h3>
        <p className="hint">Escolha uma ferramenta na barra acima ou selecione um item na página.</p>
        {pendingCount > 0 && (
          <p className="hint">
            {pendingCount} {pendingCount === 1 ? 'edição pendente' : 'edições pendentes'}: são gravadas no PDF ao salvar.
          </p>
        )}
      </aside>
    );
  }

  if (selected) {
    const o = selected;
    // Um ponto de desfazer por interação (sliders e seletor de cor disparam muitos eventos).
    const upd = (patch: Partial<EditObject>) => s().updateObject(o.id, patch);
    return (
      <aside className="properties" onPointerDownCapture={() => s().checkpoint('Propriedades')}>
        <h3>{OBJ_NAMES[o.kind]}</h3>
        {o.kind === 'text' && (
          <>
            <TextStyle font={o.font} size={o.size} bold={o.bold} italic={o.italic} color={o.color}
              onChange={(p) => upd(p as Partial<EditObject>)} />
            <Field label="Fundo">
              <div className="row">
                <input type="checkbox" checked={!!o.bg} onChange={(e) => upd({ bg: e.target.checked ? '#ffffff' : null })} />
                {o.bg && <ColorInput value={o.bg} onChange={(v) => upd({ bg: v })} label="Cor do fundo" />}
              </div>
            </Field>
            <p className="hint">Dê dois cliques no texto para editá-lo.</p>
          </>
        )}
        {(o.kind === 'rect' || o.kind === 'ellipse') && (
          <>
            <Field label="Contorno">
              <div className="row">
                <input type="checkbox" checked={!!o.stroke} onChange={(e) => upd({ stroke: e.target.checked ? style.color : null })} />
                {o.stroke && <ColorInput value={o.stroke} onChange={(v) => upd({ stroke: v })} label="Cor do contorno" />}
              </div>
            </Field>
            <Field label="Preenchimento">
              <div className="row">
                <input type="checkbox" checked={!!o.fill} onChange={(e) => upd({ fill: e.target.checked ? '#bbdefb' : null })} />
                {o.fill && <ColorInput value={o.fill} onChange={(v) => upd({ fill: v })} label="Cor do preenchimento" />}
              </div>
            </Field>
            <Width value={o.width} onChange={(width) => upd({ width })} />
            <Opacity value={o.opacity} onChange={(opacity) => upd({ opacity })} />
          </>
        )}
        {(o.kind === 'line' || o.kind === 'arrow' || o.kind === 'ink') && (
          <>
            <Field label="Cor"><ColorInput value={o.stroke} onChange={(v) => upd({ stroke: v })} /></Field>
            <Width value={o.width} onChange={(width) => upd({ width })} />
            <Opacity value={o.opacity} onChange={(opacity) => upd({ opacity })} />
          </>
        )}
        {(o.kind === 'highlight' || o.kind === 'underline' || o.kind === 'strike' || o.kind === 'whiteout') && (
          <Field label="Cor"><ColorInput value={o.color} onChange={(v) => upd({ color: v })} /></Field>
        )}
        {o.kind === 'image' && <Opacity value={o.opacity} onChange={(opacity) => upd({ opacity })} />}
        {o.kind === 'note' && (
          <Field label="Cor do ícone"><ColorInput value={o.color} onChange={(v) => upd({ color: v })} /></Field>
        )}
        {o.kind === 'field' && (
          <>
            <Field label="Tipo">
              <FieldTypeSelect value={o.fieldType} onChange={(fieldType) => upd({ fieldType })} />
            </Field>
            <Field label={o.fieldType === 'radio' ? 'Nome do grupo' : 'Nome do campo'} hint={o.fieldType === 'radio' ? 'Botões com o mesmo nome formam um grupo (só um pode ser marcado).' : undefined}>
              <input value={o.name} onChange={(e) => upd({ name: e.target.value })} />
            </Field>
            {o.fieldType === 'radio' && (
              <Field label="Valor deste botão">
                <input value={o.options[0] ?? ''} onChange={(e) => upd({ options: [e.target.value] })} />
              </Field>
            )}
            {o.fieldType === 'dropdown' && (
              <Field label="Opções (uma por linha)">
                <textarea rows={4} value={o.options.join('\n')} onChange={(e) => upd({ options: e.target.value.split('\n') })} />
              </Field>
            )}
            {(o.fieldType === 'text' || o.fieldType === 'multiline' || o.fieldType === 'dropdown') && (
              <Field label="Tamanho da fonte">
                <input type="number" min={6} max={36} value={o.fontSize} onChange={(e) => upd({ fontSize: Number(e.target.value) || 11 })} />
              </Field>
            )}
            {(o.fieldType === 'text' || o.fieldType === 'multiline') && (
              <Field label="Valor inicial"><input value={o.value} onChange={(e) => upd({ value: e.target.value })} /></Field>
            )}
            {(o.fieldType === 'checkbox' || o.fieldType === 'radio') && (
              <label className="check"><input type="checkbox" checked={o.value === 'true'} onChange={(e) => upd({ value: e.target.checked ? 'true' : '' })} /> Marcado inicialmente</label>
            )}
            {o.fieldType !== 'signature' && (
              <label className="check"><input type="checkbox" checked={o.required} onChange={(e) => upd({ required: e.target.checked })} /> Obrigatório</label>
            )}
          </>
        )}
        {o.kind === 'link' && <LinkProps o={o} onChange={upd} />}
        {o.kind === 'redact' && (
          <p className="hint">O conteúdo sob esta tarja será removido definitivamente quando o documento for salvo.</p>
        )}
        <div className="row actions">
          <button onClick={() => {
            const copy = { ...structuredClone(o), id: newId() } as EditObject;
            const shifted = 'x1' in copy
              ? { ...copy, x1: copy.x1 + 10, y1: copy.y1 + 10, x2: copy.x2 + 10, y2: copy.y2 + 10 }
              : copy.kind === 'ink' ? { ...copy, points: copy.points.map(([x, y]) => [x + 10, y + 10] as [number, number]) }
              : { ...copy, x: copy.x + 10, y: copy.y + 10 };
            s().addObject(shifted as EditObject);
          }}><Copy size={16} /> Duplicar</button>
          <button className="danger" onClick={() => s().removeObject(o.id)}><Trash2 size={16} /> Excluir</button>
        </div>
      </aside>
    );
  }

  const set = (p: Partial<ToolStyle>) => s().setStyle(p);
  return (
    <aside className="properties">
      <h3>{TOOL_NAMES[tool]}</h3>
      {TOOL_HELP[tool] && <p className="hint">{TOOL_HELP[tool]}</p>}
      {tool === 'text' && (
        <TextStyle font={style.font} size={style.fontSize} bold={style.bold} italic={style.italic} color={style.color}
          onChange={(p) => set({ ...p, fontSize: p.size ?? style.fontSize })} />
      )}
      {tool === 'field' && (
        <Field label="Tipo de campo">
          <FieldTypeSelect value={style.fieldType} onChange={(fieldType) => set({ fieldType })} />
        </Field>
      )}
      {tool === 'highlight' && <Field label="Cor"><ColorInput value={style.highlight} onChange={(v) => set({ highlight: v })} /></Field>}
      {(tool === 'underline' || tool === 'strike') && <Field label="Cor"><ColorInput value={style.color} onChange={(v) => set({ color: v })} /></Field>}
      {(tool === 'ink' || tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow') && (
        <>
          <Field label="Cor"><ColorInput value={style.color} onChange={(v) => set({ color: v })} /></Field>
          {(tool === 'rect' || tool === 'ellipse') && (
            <Field label="Preenchimento">
              <div className="row">
                <input type="checkbox" checked={!!style.fill} onChange={(e) => set({ fill: e.target.checked ? '#bbdefb' : null })} />
                {style.fill && <ColorInput value={style.fill} onChange={(v) => set({ fill: v })} />}
              </div>
            </Field>
          )}
          <Width value={style.width} onChange={(width) => set({ width })} />
          <Opacity value={style.opacity} onChange={(opacity) => set({ opacity })} />
        </>
      )}
    </aside>
  );
}

function TextStyle(props: {
  font: FontFamily; size: number; bold: boolean; italic: boolean; color: string;
  onChange: (p: Partial<{ font: FontFamily; size: number; bold: boolean; italic: boolean; color: string }>) => void;
}) {
  return (
    <>
      <Field label="Fonte">
        <select value={props.font} onChange={(e) => props.onChange({ font: e.target.value as FontFamily })}>
          <option value="Helvetica">Helvetica (sem serifa)</option>
          <option value="Times">Times (com serifa)</option>
          <option value="Courier">Courier (monoespaçada)</option>
        </select>
      </Field>
      <Field label="Tamanho">
        <input type="number" min={4} max={200} step={0.5} value={props.size} onChange={(e) => props.onChange({ size: Math.max(4, Number(e.target.value) || 12) })} />
      </Field>
      <div className="row">
        <button className={`icon ${props.bold ? 'active' : ''}`} title="Negrito" onClick={() => props.onChange({ bold: !props.bold })}><Bold size={16} /></button>
        <button className={`icon ${props.italic ? 'active' : ''}`} title="Itálico" onClick={() => props.onChange({ italic: !props.italic })}><Italic size={16} /></button>
        <ColorInput value={props.color} onChange={(color) => props.onChange({ color })} label="Cor do texto" />
      </div>
    </>
  );
}

function Width({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Field label={`Espessura: ${value} pt`}>
      <input type="range" min={0.5} max={20} step={0.5} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </Field>
  );
}

function Opacity({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Field label={`Opacidade: ${Math.round(value * 100)}%`}>
      <input type="range" min={0.1} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </Field>
  );
}

function FieldTypeSelect({ value, onChange }: { value: FieldType; onChange: (v: FieldType) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as FieldType)}>
      <option value="text">Texto (uma linha)</option>
      <option value="multiline">Texto (várias linhas)</option>
      <option value="checkbox">Caixa de seleção</option>
      <option value="radio">Botão de opção</option>
      <option value="dropdown">Lista suspensa</option>
      <option value="signature">Campo de assinatura</option>
    </select>
  );
}

function LinkProps({ o, onChange }: { o: LinkObject; onChange: (p: Partial<EditObject>) => void }) {
  const pages = useStore((s) => s.pageSizes.length);
  const toPage = !o.url && o.targetPage >= 0;
  const [mode, setMode] = useState<'url' | 'page'>(o.url ? 'url' : toPage && o.targetPage > 0 ? 'page' : 'url');
  return (
    <>
      <label className="radio"><input type="radio" checked={mode === 'url'} onChange={() => setMode('url')} /> Site ou e-mail</label>
      <label className="radio"><input type="radio" checked={mode === 'page'} onChange={() => { setMode('page'); onChange({ url: '' }); }} /> Página deste documento</label>
      {mode === 'url' ? (
        <Field label="Endereço" hint="Ex.: www.exemplo.com.br ou nome@exemplo.com">
          <input value={o.url} placeholder="https://" onChange={(e) => onChange({ url: e.target.value })} autoFocus />
        </Field>
      ) : (
        <Field label={`Página (1 a ${pages})`}>
          <input type="number" min={1} max={pages} value={o.targetPage + 1}
            onChange={(e) => onChange({ targetPage: Math.min(pages, Math.max(1, Number(e.target.value) || 1)) - 1 })} />
        </Field>
      )}
    </>
  );
}
