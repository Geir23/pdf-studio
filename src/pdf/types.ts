// Objetos de edição ficam "vivos" (movíveis, editáveis) até serem gravados no PDF.
// Coordenadas: espaço de visualização da página em escala 1 (pontos PDF, origem no
// canto superior esquerdo, já considerando a rotação da página).

export type FontFamily = 'Helvetica' | 'Times' | 'Courier';

interface Base {
  id: string;
  page: number; // índice começando em 0
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextObject extends Base, Box {
  kind: 'text';
  text: string;
  size: number;
  color: string;
  font: FontFamily;
  bold: boolean;
  italic: boolean;
  /** Cor de fundo para cobrir o texto original (usada em "Editar texto"). */
  bg: string | null;
}

export interface ImageObject extends Base, Box {
  kind: 'image';
  dataUrl: string;
  opacity: number;
}

export interface ShapeObject extends Base, Box {
  kind: 'rect' | 'ellipse';
  stroke: string | null;
  fill: string | null;
  width: number;
  opacity: number;
}

export interface LineObject extends Base {
  kind: 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  width: number;
  opacity: number;
}

export interface InkObject extends Base {
  kind: 'ink';
  points: [number, number][];
  stroke: string;
  width: number;
  opacity: number;
}

export interface MarkupObject extends Base, Box {
  kind: 'highlight' | 'underline' | 'strike';
  color: string;
}

export interface CoverObject extends Base, Box {
  kind: 'whiteout' | 'redact';
  color: string;
}

export interface NoteObject extends Base {
  kind: 'note';
  x: number;
  y: number;
  text: string;
  color: string;
  author: string;
}

export type EditObject =
  | TextObject
  | ImageObject
  | ShapeObject
  | LineObject
  | InkObject
  | MarkupObject
  | CoverObject
  | NoteObject;

export type BoxObject = Extract<EditObject, Box>;

export function hasBox(o: EditObject): o is BoxObject {
  return 'w' in o && 'h' in o;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}
