import { createMarkdownContent } from 'defuddle/full';

/** Crate validates content; Defuddle owns every HTML-to-Markdown formatting rule. */
export function articleMarkdown(body: HTMLElement, base: string): string {
  const pending: { node: Element; depth: number }[] = [{ node: body, depth: 0 }];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (depth > 100) throw new Error('Article nesting is too deep');
    for (const child of Array.from(node.children)) pending.push({ node: child, depth: depth + 1 });
  }
  // Reading currently saves text, not remote media or executable embeds.
  for (const element of Array.from(body.querySelectorAll('script,style,iframe,object,embed,form,svg,img,video,audio,input,button,noscript,template'))) element.remove();
  for (const link of Array.from(body.querySelectorAll('a[href]'))) {
    try {
      const url = new URL(link.getAttribute('href')!, base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe link');
      link.setAttribute('href', url.href);
    } catch { link.removeAttribute('href'); }
  }
  const markdown = createMarkdownContent(body.innerHTML, base);
  // Defuddle reports conversion failure as a string containing the original HTML.
  // Never publish that fallback as a successfully extracted article.
  if (markdown.startsWith('Partial conversion completed with errors. Original HTML:')) throw new Error('Article Markdown conversion failed');
  return markdown;
}
