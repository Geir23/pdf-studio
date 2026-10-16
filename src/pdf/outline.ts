import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFObject, PDFRef, PDFString } from 'pdf-lib';

export interface OutlineItem {
  title: string;
  /** Página de destino (base 0); null quando o destino não pôde ser resolvido. */
  page: number | null;
  children: OutlineItem[];
}

function decode(v: PDFObject | undefined): string {
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
}

/** Procura um destino nomeado no dicionário /Dests ou na árvore /Names /Dests. */
function namedDest(doc: PDFDocument, name: string): PDFObject | undefined {
  const dests = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
  const fromDict = dests?.lookup(PDFName.of(name));
  if (fromDict) return fromDict;
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookupMaybe(PDFName.of('Dests'), PDFDict);
  const search = (node: PDFDict | undefined, depth = 0): PDFObject | undefined => {
    if (!node || depth > 32) return undefined;
    const arr = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (arr) {
      for (let i = 0; i + 1 < arr.size(); i += 2) {
        if (decode(arr.lookup(i)) === name) return arr.lookup(i + 1);
      }
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    for (let i = 0; kids && i < kids.size(); i++) {
      const found = search(kids.lookup(i, PDFDict), depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return search(names);
}

function destPage(doc: PDFDocument, item: PDFDict): number | null {
  let dest: PDFObject | undefined = item.lookup(PDFName.of('Dest'));
  if (!dest) {
    const action = item.lookupMaybe(PDFName.of('A'), PDFDict);
    if (action && (action.lookup(PDFName.of('S')) as PDFName | undefined)?.asString() === '/GoTo') {
      dest = action.lookup(PDFName.of('D'));
    }
  }
  if (dest instanceof PDFName) dest = namedDest(doc, dest.decodeText());
  else if (dest instanceof PDFString || dest instanceof PDFHexString) dest = namedDest(doc, dest.decodeText());
  if (dest instanceof PDFDict) dest = dest.lookup(PDFName.of('D'));
  if (!(dest instanceof PDFArray)) return null;
  const target = dest.get(0);
  if (target instanceof PDFNumber) return target.asNumber();
  const index = doc.getPages().findIndex((p) => p.ref === target);
  return index >= 0 ? index : null;
}

export async function readOutline(bytes: Uint8Array): Promise<OutlineItem[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const root = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  const seen = new Set<PDFDict>();
  const walk = (first: PDFDict | undefined, depth: number): OutlineItem[] => {
    const out: OutlineItem[] = [];
    for (let node = first; node && !seen.has(node) && depth < 64; node = node.lookupMaybe(PDFName.of('Next'), PDFDict)) {
      seen.add(node);
      out.push({
        title: decode(node.lookup(PDFName.of('Title'))),
        page: destPage(doc, node),
        children: walk(node.lookupMaybe(PDFName.of('First'), PDFDict), depth + 1),
      });
    }
    return out;
  };
  return walk(root?.lookupMaybe(PDFName.of('First'), PDFDict), 0);
}

/** Substitui os marcadores do documento pela árvore informada. */
export async function writeOutline(bytes: Uint8Array, items: OutlineItem[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  const ctx = doc.context;
  if (!items.length) {
    doc.catalog.delete(PDFName.of('Outlines'));
    return doc.save();
  }
  const rootRef = ctx.nextRef();
  const build = (list: OutlineItem[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = list.map(() => ctx.nextRef());
    let count = 0;
    list.forEach((it, i) => {
      const dict = ctx.obj({}) as PDFDict;
      dict.set(PDFName.of('Title'), PDFHexString.fromText(it.title || 'Sem título'));
      dict.set(PDFName.of('Parent'), parent);
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < list.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      const page = it.page !== null && pages[it.page] ? pages[it.page] : null;
      if (page) dict.set(PDFName.of('Dest'), ctx.obj([page.ref, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]));
      if (it.children.length) {
        const sub = build(it.children, refs[i]);
        dict.set(PDFName.of('First'), sub.first);
        dict.set(PDFName.of('Last'), sub.last);
        dict.set(PDFName.of('Count'), PDFNumber.of(-sub.count)); // recolhido
      }
      ctx.assign(refs[i], dict);
      count += 1;
    });
    return { first: refs[0], last: refs[refs.length - 1], count };
  };
  const top = build(items, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: PDFNumber.of(top.count) }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  return doc.save();
}
