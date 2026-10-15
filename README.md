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

**Ferramentas**
- **OCR** (português e inglês) para tornar documentos escaneados pesquisáveis
- Marca d'água, cabeçalho/rodapé e numeração de páginas
- Preencher formulários (e achatar)
- Comprimir (sem perdas ou convertendo em imagem)
- Proteger com senha (AES-256) e permissões
- Exportar para Word (.docx), imagens (PNG/JPG) e texto
- Imagens → PDF
- Comparar duas versões (diferenças de texto por página)
- Propriedades/metadados, impressão

**Assinar**
- Assinatura eletrônica: desenhar, digitar ou usar imagem (remove o fundo branco); fica
  salva para reutilizar
- **Assinatura digital** com certificado A1 (.pfx/.p12), padrão PKCS#7
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

## Testes

```bash
npm test           # testes do núcleo (precisa do poppler-utils: pdftotext, pdfsig)
npm run build && npm run test:e2e   # testes no Chromium, clicando como um usuário
```

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

- **Editar texto existente** usa as fontes padrão do PDF (Helvetica, Times, Courier) para
  o texto novo, que pode não ser idêntico à fonte original. Caracteres fora do alfabeto
  latino (ex.: chinês, cirílico) no texto *novo* viram "?". Texto dentro de objetos de
  formulário (XObjects) é apenas coberto, não removido.
- **Assinatura digital**: só certificados A1 em arquivo. Tokens e cartões A3 não são
  acessíveis pelo navegador (ficam para a versão desktop). Ainda não há carimbo de tempo
  (TSA) nem validação da cadeia ICP-Brasil.
- **Exportar para Word** preserva o texto e as quebras de página; colunas e tabelas são
  simplificadas.
- Ainda não implementado: criar campos de formulário, editar marcadores e links,
  conversão para PDF/A, exportar para Excel/PowerPoint.
