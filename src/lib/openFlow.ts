import { PasswordRequiredError, openPdf } from '../pdf/pdfjs';
import { decryptPdf, isEncrypted } from '../pdf/tools';
import { useStore } from '../store';
import { fileToBytes } from './bytes';
import { ask } from './prompt';

/**
 * Lê um PDF, pedindo a senha se necessário. Devolve os bytes já sem criptografia
 * (o app trabalha sobre a cópia aberta) e a senha usada, ou null se cancelado.
 */
export async function readPdfFile(file: File): Promise<{ bytes: Uint8Array; password: string | null } | null> {
  const raw = await fileToBytes(file);
  let password: string | undefined;
  let incorrect = false;
  for (;;) {
    try {
      const view = await openPdf(raw, password);
      void view.loadingTask.destroy();
      break;
    } catch (e) {
      if (!(e instanceof PasswordRequiredError)) {
        throw new Error(`Não foi possível abrir "${file.name}". O arquivo pode estar corrompido ou não ser um PDF.`);
      }
      const answer = await ask({
        title: 'Documento protegido',
        message: incorrect || e.incorrect ? 'Senha incorreta. Tente novamente.' : `"${file.name}" é protegido por senha.`,
        label: 'Senha',
        password: true,
      });
      if (answer === null) return null;
      password = answer;
      incorrect = true;
    }
  }
  // Arquivo sem criptografia segue intacto (regravá-lo invalidaria assinaturas digitais).
  if (!(await isEncrypted(raw).catch(() => false))) return { bytes: raw, password: null };
  try {
    // Remove a criptografia (inclusive a de "somente permissões", com senha de usuário vazia).
    const bytes = await decryptPdf(raw, password ?? '');
    return { bytes, password: password ?? null };
  } catch {
    return { bytes: raw, password: password ?? null };
  }
}

export async function openFile(file: File) {
  const store = useStore.getState();
  if (store.dirty && !window.confirm('Há alterações não salvas. Abrir outro arquivo mesmo assim?')) return;
  await store.run('Abrindo documento…', async () => {
    const result = await readPdfFile(file);
    if (!result) return;
    const security = result.password
      ? {
          userPassword: result.password,
          ownerPassword: result.password,
          allowPrinting: true,
          allowCopying: true,
          allowModifying: true,
          allowAnnotating: true,
          allowFillingForms: true,
        }
      : null;
    await store.load(result.bytes, file.name, { security });
    if (security) store.toast('Documento desbloqueado. Ele será salvo com a mesma senha (altere em Ferramentas › Proteger).');
  });
}
