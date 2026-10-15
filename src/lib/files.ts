/** Abre o seletor de arquivos do sistema. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Normaliza qualquer imagem para PNG ou JPEG (formatos que o PDF aceita direto). */
export async function imageFileToDataUrl(file: File): Promise<{ dataUrl: string; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const { width: w, height: h } = bmp;
  if (file.type === 'image/png' || file.type === 'image/jpeg') {
    return { dataUrl: await readAsDataUrl(file), w, h };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  return { dataUrl: canvas.toDataURL('image/png'), w, h };
}
