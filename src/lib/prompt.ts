import { create } from 'zustand';

interface PromptRequest {
  title: string;
  message?: string;
  label: string;
  password?: boolean;
  initial?: string;
  resolve: (value: string | null) => void;
}

export const usePrompt = create<{ request: PromptRequest | null }>(() => ({ request: null }));

/** Caixa de diálogo com um campo de texto; devolve null se o usuário cancelar. */
export function ask(opts: Omit<PromptRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    usePrompt.setState({
      request: {
        ...opts,
        resolve: (v) => {
          usePrompt.setState({ request: null });
          resolve(v);
        },
      },
    });
  });
}
