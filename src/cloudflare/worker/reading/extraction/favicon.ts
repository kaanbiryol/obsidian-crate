import { readingFaviconUrl } from '@/reading/core/model';

/** Discover a page's declared icon without downloading another resource. */
export function discoverFaviconUrl(document: Document, pageUrl: string): string | undefined {
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel][href]'))
    .filter(link => link.getAttribute('rel')!.toLowerCase().split(/\s+/).includes('icon')
      && (!link.getAttribute('type') || /^image\//i.test(link.getAttribute('type')!)));
  // A general-purpose icon works in both light and dark hosts. Prefer bitmap
  // declarations, but use the site's other icon when that is all it offers.
  links.sort((a, b) => Number(!!a.getAttribute('media')) - Number(!!b.getAttribute('media'))
    || Number(a.getAttribute('type') === 'image/svg+xml') - Number(b.getAttribute('type') === 'image/svg+xml'));
  for (const link of links) {
    try { return readingFaviconUrl(new URL(link.getAttribute('href')!, pageUrl).href); }
    catch { /* Try the next declared icon. */ }
  }
  return undefined;
}
