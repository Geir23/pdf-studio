# PDF Studio

Leitor e editor de PDF completo que roda no navegador. **Os arquivos nunca saem do
computador**: todo o processamento (edição, OCR, assinatura) acontece localmente.

## Funcionalidades

**Visualizar**
- Miniaturas, marcadores (sumário), zoom (Ctrl + roda do mouse), ferramenta "mão"
- Pesquisa no texto (ignora acentos e maiúsculas), seleção e cópia de texto
- Painel de comentários existentes no documento
- Abre PDFs protegidos por senha

**Editar**
- **Editar texto existente**: clique em um trecho e reescreva. O texto original é
  *removido* do arquivo (não só coberto), então a busca e a cópia já mostram o valor novo
- Adicionar texto (fonte, tamanho, cor, negrito, itálico)
- Destacar, sublinhar e tachar (encaixa automaticamente no texto)
- Comentários (viram anotações PDF padrão, visíveis em qualquer leitor)
- Desenho livre, retângulo, elipse, linha, seta, imagens
- Apagar (cobrir com branco) e **redigir** de verdade (a área tarjada vira imagem e o
  conteúdo por baixo é eliminado)
- Desfazer/refazer, mover, redimensionar, duplicar

**Páginas**
- Reordenar arrastando, girar, excluir, duplicar, inserir em branco, inserir outro PDF
- Extrair, dividir (a cada N páginas, por intervalos), combinar vários PDFs, cortar margens

**Formulários, links e marcadores**
- Criar campos: texto, várias linhas, caixa de seleção, botão de opção, lista suspensa e campo de assinatura
- Criar links para sites, e-mails ou páginas do documento; links existentes são clicáveis
- Adicionar, renomear, reordenar e excluir marcadores (sumário)

**Conversor (Markdown, Word, HTML… com OCR)**
- Converte PDF, imagens (JPG, PNG, WebP…), Word, HTML e texto, vários de uma vez
- Saídas: Markdown, Markdown + imagens (.zip), HTML, Word, texto e JSON estruturado
- Mantém títulos, parágrafos, negrito/itálico, listas, tabelas, links, imagens e a ordem de leitura em duas colunas
- Remove cabeçalhos, rodapés e números de página repetidos; une palavras hifenizadas
- **OCR automático** onde o PDF não tem texto confiável: páginas escaneadas, texto que "não dá para copiar"
  (fontes sem mapa Unicode) e texto dentro de imagens; apaga bordas de tabela antes do OCR para ler as células

**Ferramentas**
- **OCR** (português e inglês) para tornar documentos escaneados pesquisáveis
- Marca d'água, cabeçalho/rodapé e numeração de páginas
- Preencher formulários (e achatar)
- Comprimir (sem perdas ou convertendo em imagem)
- Proteger com senha (AES-256) e permissões
- Exportar para Word (.docx), **Excel (.xlsx, tabelas reconstruídas)**, imagens (PNG/JPG) e texto
- **Salvar como PDF/A-2b** para arquivamento (validado com o veraPDF)
- Imagens → PDF
- Comparar duas versões (diferenças de texto por página)
- Propriedades/metadados, impressão

**Assinar**
- Assinatura eletrônica: desenhar, digitar ou usar imagem (remove o fundo branco); fica
  salva para reutilizar
- **Assinatura digital** com certificado A1 (.pfx/.p12) ou, no app desktop para Windows,
  com certificados instalados no Windows, incluindo **tokens e cartões A3** (o Windows pede o PIN), padrão PKCS#7
  (`adbe.pkcs7.detached`), com aparência visível. Salva de forma incremental, então
  várias assinaturas no mesmo documento continuam válidas
- Verificação das assinaturas do documento (integridade criptográfica)
- Gerador de certificado de teste (autoassinado, sem validade jurídica)

## Como rodar

Requer Node.js 20 ou mais novo.

```bash
npm install
npm run dev        # abre em http://localhost:5173
npm run build      # gera a versão final em dist/
npm run preview    # serve a pasta dist/
```

## App desktop (Windows)

Cada envio para a branch `main` gera, no GitHub Actions, um instalador e uma versão portátil,
publicados na página **Releases** do repositório. Para rodar o app desktop a partir do código:

```bash
npm run desktop       # abre o app no Electron
npm run desktop:win   # gera o instalador (em um computador com Windows)
```

## Testes

```bash
npm test           # testes do núcleo (precisa do poppler-utils: pdftotext, pdfsig)
npm run build && npm run test:e2e   # testes no Chromium, clicando como um usuário
npm run test:converter               # Conversor no Chromium (lote com PDF, escaneado, imagem e Word)
xvfb-run -a npm run test:desktop     # app desktop (Electron); rode depois do test:e2e
```

Para validar o PDF/A com o veraPDF, defina `VERAPDF_LIB` com a pasta dos `.jar`
(veja `.github/verapdf/pom.xml`).

Os testes conferem os PDFs gerados com ferramentas independentes (poppler): texto
extraído, rotação, criptografia e validade das assinaturas digitais.

## Publicação

O workflow em `.github/workflows/deploy.yml` roda os testes e publica o app no GitHub
Pages a cada push na branch `main`. Para ativar: *Settings → Pages → Source: GitHub
Actions*.

## Arquitetura

| Pasta | Conteúdo |
| --- | --- |
| `src/pdf/` | Núcleo: edição (`flatten`), páginas, ferramentas, OCR, assinatura, verificação, remoção de texto (`contentText`) |
| `src/components/` | Interface React: visualizador, camada de edição, barras, painéis e janelas |
| `src/store.ts` | Estado do documento, histórico de desfazer e operações |
| `tests/unit/` | Testes do núcleo (Vitest) |
| `tests/e2e/` | Teste ponta a ponta no navegador (Playwright) |

Bibliotecas principais (todas de código aberto): [pdf.js](https://github.com/mozilla/pdf.js)
(visualização), [pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (edição e
criptografia), [Tesseract.js](https://github.com/naptha/tesseract.js) (OCR),
[@signpdf](https://github.com/vbuch/node-signpdf) e [node-forge](https://github.com/digitalbazaar/forge)
(assinatura digital), [docx](https://github.com/dolanmiu/docx) (exportação para Word).

## Limitações conhecidas

- **Editar texto existente**: o texto novo usa as fontes Liberation (mesmas medidas de Arial,
  Times e Courier), que podem não ser idênticas à fonte original. Caracteres sem suporte
  nelas (ex.: chinês) viram "?". Texto dentro de objetos de formulário (XObjects) é apenas
  coberto, não removido.
- **Assinatura digital**: ainda não há carimbo de tempo (TSA) nem validação da cadeia
  ICP-Brasil. No navegador, só certificados A1 em arquivo; A3 apenas no app desktop para Windows.
- **Exportar para Word/Excel**: preserva texto, parágrafos e tabelas simples; layouts
  complexos são simplificados.
- **Conversor**: o OCR pode errar em letras pequenas, borradas ou manuscritas; o app avisa quando
  usou OCR. Negrito e itálico não são detectados em páginas reconhecidas por OCR. Layouts muito
  complexos (revistas, formulários) podem sair com a ordem de leitura simplificada.
- **PDF/A**: documentos com fontes não embutidas ou campos de formulário não passam na
  validação; o app avisa antes de gerar.
- O app desktop não tem assinatura de código paga; o Windows pode exibir um aviso na
  primeira execução ("Mais informações" › "Executar assim mesmo").
