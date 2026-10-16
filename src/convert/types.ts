// Modelo intermediário do Conversor: página → itens de texto posicionados → blocos.

/** Trecho de texto com posição (espaço de visualização da página, origem no topo-esquerda, em pontos). */
export interface TextPiece {
  x0: number;
  x1: number;
  /** Linha de base. */
  baseline: number;
  size: number;
  str: string;
  bold: boolean;
  italic: boolean;
  link?: string;
  /** Veio do OCR (não do texto do PDF). */
  ocr?: boolean;
  /** Texto lido de dentro de uma imagem (gráfico, print): nunca vira título. */
  fromImage?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageData {
  index: number;
  width: number;
  height: number;
  items: TextPiece[];
  images: Rect[];
  links: { rect: Rect; url: string }[];
}

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  link?: string;
}

export type Block =
  | { type: 'heading'; level: number; content: Inline[]; page: number; size?: number }
  | { type: 'paragraph'; content: Inline[]; page: number }
  | { type: 'list'; ordered: boolean; items: Inline[][]; page: number }
  | { type: 'table'; rows: string[][]; page: number }
  | { type: 'image'; name: string; alt: string; page: number; rect: Rect; png?: Uint8Array };

export interface ConvertedDocument {
  title: string;
  blocks: Block[];
  /** Páginas que passaram por OCR, com o motivo. */
  ocrPages: { page: number; reason: 'escaneada' | 'texto-ilegivel' }[];
  /** Imagens cujo texto foi reconhecido por OCR. */
  ocrImages: number;
  pageCount: number;
}

export const inlineText = (c: Inline[]) => c.map((i) => i.text).join('');
