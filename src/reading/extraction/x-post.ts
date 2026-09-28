function postId(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(url.hostname)) return undefined;
    return url.pathname.match(/^\/[^/]+\/status\/(\d+)\/?$/)?.[1];
  } catch { return undefined; }
}

export function isXPost(url: string): boolean { return postId(url) !== undefined; }

/** X's public SSR markup lacks the data-testid attributes Defuddle recognizes.
 * Select the requested post by its permalink, never the surrounding login shell
 * or a metadata preview (which can be truncated). No third-party fetch is used.
 */
export function extractServerRenderedPost(document: Document, url: string) {
  const id = postId(url);
  if (!id || document.querySelector('[data-testid="tweet"], [data-testid="twitterArticleRichTextView"]')) return null;
  for (const article of Array.from(document.querySelectorAll('article'))) {
    const permalink = Array.from(article.querySelectorAll('a[href]')).find(link =>
      link.closest('article') === article && !link.closest('[data-engagement-action]')
      && link.hasAttribute('data-base-ui-tooltip-trigger') && postId(link.getAttribute('href')!, url) === id);
    if (!permalink) continue;
    const body = article.querySelector('div[dir="auto"]');
    if (!body?.textContent?.trim()) continue;
    const clone = body.cloneNode(true) as HTMLElement;
    // These post bodies use white-space: pre-wrap; keep authored line breaks.
    const pending: Node[] = [clone];
    while (pending.length) {
      const node = pending.pop()!;
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3 && child.textContent?.includes('\n')) {
          const fragment = document.createDocumentFragment();
          child.textContent.split('\n').forEach((line, index) => {
            if (index) fragment.appendChild(document.createElement('br'));
            fragment.appendChild(document.createTextNode(line));
          });
          node.replaceChild(fragment, child);
        } else pending.push(child);
      }
    }
    const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title;
    const author = title?.replace(/ on X\s*$/, '');
    return { content: clone.outerHTML, title, author };
  }
  return null;
}
