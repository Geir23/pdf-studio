import { rgb, type RGB } from 'pdf-lib';

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export function hexToArray(hex: string): [number, number, number] {
  const c = hexToRgb(hex);
  return [c.red, c.green, c.blue];
}
