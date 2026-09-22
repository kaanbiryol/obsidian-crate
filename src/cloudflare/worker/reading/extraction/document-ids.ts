/** Defuddle 0.19.4 builds selectors from IDs without escaping them. React's S:0
 * IDs can throw during short-article retries and cause a whole-body fallback.
 * Remap only unsafe IDs for extraction, then restore original fragment targets.
 */
export function prepareDocumentIds(document: Document): (extracted: Document) => void {
  const replacements = new Map<string, string>();
  let sequence = 0;
  for (const element of Array.from(document.querySelectorAll('[id]'))) {
    if (/^[a-zA-Z_][\w-]*$/.test(element.id)) continue;
    const original = element.id;
    let replacement = replacements.get(original);
    if (!replacement) {
      do { replacement = `crate-extraction-id-${sequence++}`; } while (document.getElementById(replacement));
      replacements.set(original, replacement);
    }
    element.id = replacement;
  }
  const rewriteFragments = (doc: Document, mapping: Map<string, string>) => {
    for (const link of Array.from(doc.querySelectorAll('a[href^="#"]'))) {
      const fragment = link.getAttribute('href')!.slice(1);
      let decoded = fragment;
      try { decoded = decodeURIComponent(fragment); } catch { /* Keep malformed fragments literal. */ }
      const replacement = mapping.get(decoded);
      if (replacement !== undefined) link.setAttribute('href', `#${replacement}`);
    }
  };
  rewriteFragments(document, replacements);
  return extracted => {
    const originals = new Map(Array.from(replacements, ([original, replacement]) => [replacement, original]));
    for (const element of Array.from(extracted.querySelectorAll('[id]'))) {
      const original = originals.get(element.id);
      if (original !== undefined) element.id = original;
    }
    rewriteFragments(extracted, originals);
  };
}
