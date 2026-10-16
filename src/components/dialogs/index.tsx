import {
  Combine, Crop, FileArchive, FileDown, FileImage, FileLock2, FileOutput, FileScan, FileSearch, FileSignature,
  FileText, Images, Sheet, Archive, ScanText, Info, Printer, ScissorsLineDashed, Stamp, Hash, Layers3, Signature, SquareDashed,
} from 'lucide-react';
import { printDocument } from '../../lib/actions';
import { flattenForm } from '../../pdf/tools';
import { useStore } from '../../store';
import { converterInbox } from '../Converter';
import { Modal } from '../ui';
import { close } from './common';
import { CompareDialog, ConvertDialog, ImagesToPdfDialog, PdfaDialog } from './ConvertTools';
import { CompressDialog, HeaderFooterDialog, OcrDialog, PropertiesDialog, ProtectDialog, WatermarkDialog } from './DocTools';
import { CropDialog, ExtractDialog, MergeDialog, SplitDialog } from './PageTools';
import { DigitalSignDialog, SignatureDialog } from './SignTools';

interface ToolCard {
  id: string;
  label: string;
  desc: string;
  icon: typeof Combine;
  needsDoc: boolean;
  action?: () => void;
}

const GROUPS: { title: string; tools: ToolCard[] }[] = [
  {
    title: 'Criar e organizar',
    tools: [
      { id: 'merge', label: 'Combinar arquivos', desc: 'Junte vários PDFs em um', icon: Combine, needsDoc: false },
      { id: 'images', label: 'Imagens para PDF', desc: 'Fotos e digitalizações', icon: Images, needsDoc: false },
      { id: 'split', label: 'Dividir', desc: 'Separe em vários arquivos', icon: ScissorsLineDashed, needsDoc: true },
      { id: 'extract', label: 'Extrair páginas', desc: 'Salve páginas escolhidas', icon: FileOutput, needsDoc: true },
      { id: 'crop', label: 'Cortar páginas', desc: 'Remova margens', icon: Crop, needsDoc: true },
    ],
  },
  {
    title: 'Editar e revisar',
    tools: [
      { id: 'ocr', label: 'Reconhecer texto (OCR)', desc: 'Torne digitalizações pesquisáveis', icon: FileScan, needsDoc: true },
      { id: 'watermark', label: 'Marca d’água', desc: 'Texto sobre as páginas', icon: Stamp, needsDoc: true },
      { id: 'headerFooter', label: 'Numeração e rodapé', desc: 'Cabeçalho, rodapé e nº de página', icon: Hash, needsDoc: true },
      { id: 'compare', label: 'Comparar arquivos', desc: 'Veja o que mudou entre versões', icon: FileSearch, needsDoc: false },
      { id: 'redact', label: 'Redigir', desc: 'Remova informações sigilosas', icon: SquareDashed, needsDoc: true,
        action: () => { useStore.getState().setTool('redact'); close(); useStore.getState().toast('Arraste sobre o conteúdo a remover. Ele é apagado de verdade ao salvar.'); } },
      { id: 'flatten', label: 'Achatar formulário', desc: 'Torne campos não editáveis', icon: Layers3, needsDoc: true,
        action: () => { const s = useStore.getState(); close(); void s.run('Achatando…', () => s.apply('Achatar formulário', flattenForm)); } },
    ],
  },
  {
    title: 'Proteger e assinar',
    tools: [
      { id: 'protect', label: 'Proteger com senha', desc: 'Criptografia AES-256 e permissões', icon: FileLock2, needsDoc: true },
      { id: 'signature', label: 'Preencher e assinar', desc: 'Assinatura eletrônica desenhada', icon: Signature, needsDoc: true },
      { id: 'digitalSign', label: 'Assinatura digital', desc: 'Com certificado A1 (.pfx)', icon: FileSignature, needsDoc: true,
        action: () => { useStore.getState().setTool('digitalSignature'); close(); useStore.getState().toast('Desenhe na página o retângulo da assinatura.'); } },
    ],
  },
  {
    title: 'Exportar e otimizar',
    tools: [
      { id: 'converter', label: 'Converter (Markdown, Word… com OCR)', desc: 'Estrutura completa, até de digitalizações', icon: ScanText, needsDoc: false,
        action: () => {
          const s = useStore.getState();
          close();
          if (!s.bytes) return s.setMode('converter');
          void s.run('Preparando…', async () => {
            converterInbox.push({ name: s.fileName || 'documento.pdf', bytes: await s.bake() });
            s.setMode('converter');
          });
        } },
      { id: 'convert:docx', label: 'Exportar para Word', desc: '.docx editável', icon: FileText, needsDoc: true },
      { id: 'convert:xlsx', label: 'Exportar para Excel', desc: 'Tabelas em .xlsx', icon: Sheet, needsDoc: true },
      { id: 'pdfa', label: 'Salvar como PDF/A', desc: 'Arquivamento (ISO 19005)', icon: Archive, needsDoc: true },
      { id: 'convert:images', label: 'Exportar imagens', desc: 'PNG ou JPG por página', icon: FileImage, needsDoc: true },
      { id: 'convert:text', label: 'Exportar texto', desc: 'Arquivo .txt', icon: FileDown, needsDoc: true },
      { id: 'compress', label: 'Comprimir', desc: 'Reduza o tamanho do arquivo', icon: FileArchive, needsDoc: true },
      { id: 'properties', label: 'Propriedades', desc: 'Título, autor, informações', icon: Info, needsDoc: true },
      { id: 'print', label: 'Imprimir', desc: 'Envie para a impressora', icon: Printer, needsDoc: true, action: () => { close(); void printDocument(); } },
    ],
  },
];

export function ToolsHub() {
  const hasDoc = useStore((s) => !!s.bytes);
  return (
    <Modal title="Todas as ferramentas" onClose={close} wide>
      {GROUPS.map((g) => (
        <section key={g.title} className="tool-group">
          <h4>{g.title}</h4>
          <div className="tool-grid">
            {g.tools.map((t) => (
              <button key={t.id} className="tool-card" disabled={t.needsDoc && !hasDoc}
                title={t.needsDoc && !hasDoc ? 'Abra um PDF primeiro' : t.desc}
                onClick={() => (t.action ? t.action() : useStore.getState().openDialog(t.id))}>
                <t.icon size={26} />
                <strong>{t.label}</strong>
                <small>{t.desc}</small>
              </button>
            ))}
          </div>
        </section>
      ))}
    </Modal>
  );
}

export function DialogHost() {
  const dialog = useStore((s) => s.dialog);
  if (!dialog) return null;
  if (dialog.startsWith('convert:')) return <ConvertDialog initial={dialog.split(':')[1] as 'docx'} />;
  switch (dialog) {
    case 'tools': return <ToolsHub />;
    case 'merge': return <MergeDialog />;
    case 'split': return <SplitDialog />;
    case 'extract': return <ExtractDialog />;
    case 'crop': return <CropDialog />;
    case 'ocr': return <OcrDialog />;
    case 'compress': return <CompressDialog />;
    case 'protect': return <ProtectDialog />;
    case 'watermark': return <WatermarkDialog />;
    case 'headerFooter': return <HeaderFooterDialog />;
    case 'properties': return <PropertiesDialog />;
    case 'images': return <ImagesToPdfDialog />;
    case 'compare': return <CompareDialog />;
    case 'pdfa': return <PdfaDialog />;
    case 'signature': return <SignatureDialog />;
    case 'digitalSign': return <DigitalSignDialog />;
    default: return null;
  }
}
