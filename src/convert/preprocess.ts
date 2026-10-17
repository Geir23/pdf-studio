// Pré-processamento da imagem antes do OCR.

export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Apaga (pinta de branco) linhas retas longas e finas, como bordas de tabela e sublinhados.
 * O Tesseract costuma ignorar regiões cercadas por bordas; sem elas, lê as células.
 * Traços de letras são curtos ou grossos e ficam intactos.
 */
export function whitenRules(img: PixelBuffer): number {
  const { data, width: w, height: h } = img;
  const dark = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < dark.length; i++, p += 4) {
    const lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    dark[i] = lum < 140 && data[p + 3] > 0 ? 1 : 0;
  }
  const minH = Math.max(80, Math.round(w * 0.04));
  const minV = Math.max(80, Math.round(h * 0.03));
  const maxThick = Math.max(3, Math.round(Math.min(w, h) * 0.0025));
  const kill = new Uint8Array(w * h);
  // espessura vertical/horizontal de um pixel escuro
  const thickV = (x: number, y: number) => {
    let a = y;
    let b = y;
    while (a > 0 && dark[(a - 1) * w + x] && y - a <= maxThick) a--;
    while (b < h - 1 && dark[(b + 1) * w + x] && b - y <= maxThick) b++;
    return b - a + 1;
  };
  const thickH = (x: number, y: number) => {
    let a = x;
    let b = x;
    while (a > 0 && dark[y * w + a - 1] && x - a <= maxThick) a--;
    while (b < w - 1 && dark[y * w + b + 1] && b - x <= maxThick) b++;
    return b - a + 1;
  };
  for (let y = 0; y < h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const d = x < w && dark[y * w + x];
      if (d && start < 0) start = x;
      if (!d && start >= 0) {
        if (x - start >= minH) {
          const mid = (start + x) >> 1;
          if (thickV(mid, y) <= maxThick) for (let k = start; k < x; k++) kill[y * w + k] = 1;
        }
        start = -1;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const d = y < h && dark[y * w + x];
      if (d && start < 0) start = y;
      if (!d && start >= 0) {
        if (y - start >= minV) {
          const mid = (start + y) >> 1;
          if (thickH(x, mid) <= maxThick) for (let k = start; k < y; k++) kill[k * w + x] = 1;
        }
        start = -1;
      }
    }
  }
  let n = 0;
  for (let i = 0, p = 0; i < kill.length; i++, p += 4) {
    if (!kill[i]) continue;
    data[p] = data[p + 1] = data[p + 2] = 255;
    n++;
  }
  return n;
}

/**
 * Fração dos pixels com a cor de fundo predominante (0–1). Gráficos, prints e páginas
 * digitalizadas têm fundo liso (valor alto); fotos têm valor baixo e não valem o OCR.
 */
export function backgroundShare(img: PixelBuffer): number {
  const hist = new Uint32Array(64);
  let n = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 40000))); // ~40 mil amostras
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const p = (y * img.width + x) * 4;
      const lum = (0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2]) | 0;
      hist[lum >> 2]++;
      n++;
    }
  }
  let best = 0;
  for (let i = 0; i < 64; i++) {
    const around = hist[i] + (hist[i - 1] ?? 0) + (hist[i + 1] ?? 0);
    if (around > best) best = around;
  }
  return n ? best / n : 0;
}
