import './lib/polyfills';
import 'pdfjs-dist/web/pdf_viewer.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { registerWebFonts, setFontLoader } from './pdf/fonts';
import { assetUrl } from './pdf/pdfjs';

setFontLoader(async (file) => {
  const res = await fetch(assetUrl(`vendor/fonts/${file}`));
  if (!res.ok) throw new Error(`Fonte não encontrada: ${file}`);
  return new Uint8Array(await res.arrayBuffer());
});
registerWebFonts((file) => assetUrl(`vendor/fonts/${file}`));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
