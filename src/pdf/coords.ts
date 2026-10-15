import type { PDFPage } from 'pdf-lib';

export interface PageGeom {
  x0: number;
  y0: number;
  w: number; // largura da caixa no espaço PDF
  h: number;
  rot: 0 | 90 | 180 | 270;
  viewW: number; // largura como o usuário vê (após rotação)
  viewH: number;
}

export function normRotation(angle: number): 0 | 90 | 180 | 270 {
  const r = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

export function pageGeom(page: PDFPage): PageGeom {
  const box = page.getCropBox();
  const rot = normRotation(page.getRotation().angle);
  const swap = rot === 90 || rot === 270;
  return {
    x0: box.x,
    y0: box.y,
    w: box.width,
    h: box.height,
    rot,
    viewW: swap ? box.height : box.width,
    viewH: swap ? box.width : box.height,
  };
}

/** Converte um ponto do espaço de visualização (topo-esquerda, escala 1) para o espaço PDF. */
export function toPdf(g: PageGeom, x: number, y: number): { x: number; y: number } {
  switch (g.rot) {
    case 0:
      return { x: g.x0 + x, y: g.y0 + g.h - y };
    case 90:
      return { x: g.x0 + y, y: g.y0 + x };
    case 180:
      return { x: g.x0 + g.w - x, y: g.y0 + y };
    case 270:
      return { x: g.x0 + g.w - y, y: g.y0 + g.h - x };
  }
}

/**
 * Âncora (canto inferior esquerdo no referencial do objeto) e rotação para desenhar
 * com pdf-lib um retângulo que, visualmente, ocupa (x, y, w, h).
 */
export function placeBox(g: PageGeom, x: number, y: number, h: number) {
  const p = toPdf(g, x, y + h);
  return { x: p.x, y: p.y, rotate: g.rot };
}
