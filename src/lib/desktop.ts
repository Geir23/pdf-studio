import type { CertInfo } from '../pdf/sign';

export interface WindowsCertificate extends Omit<CertInfo, 'validFrom' | 'validTo'> {
  thumbprint: string;
  validFrom: string;
  validTo: string;
}

/** Recursos disponíveis só na versão desktop (Electron). */
export interface DesktopApi {
  platform: string;
  onOpenFile(cb: (name: string, bytes: Uint8Array) => void): () => void;
  saveFile(bytes: Uint8Array, suggestedName: string, filePath?: string): Promise<string | null>;
  setDirty(dirty: boolean): void;
  listCertificates(): Promise<WindowsCertificate[]>;
  signWithCertificate(thumbprint: string, bytes: Uint8Array): Promise<Uint8Array>;
}

export const desktop: DesktopApi | undefined = (window as unknown as { desktop?: DesktopApi }).desktop;
