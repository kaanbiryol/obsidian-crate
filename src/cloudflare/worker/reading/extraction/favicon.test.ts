import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { discoverFaviconUrl } from './favicon';

const document = (head: string) => parseHTML(`<html><head>${head}</head><body></body></html>`).document as unknown as Document;

describe('favicon discovery', () => {
  it('resolves a declared icon against the final page URL and favors a general bitmap', () => {
    const page = document('<link rel="icon" media="(prefers-color-scheme: dark)" href="/dark.svg">'
      + '<link rel="shortcut ICON" type="image/svg+xml" href="/vector.svg">'
      + '<link rel="icon" type="image/png" href="../icon.png">');
    expect(discoverFaviconUrl(page, 'https://example.com/stories/post')).toBe('https://example.com/icon.png');
  });

  it('skips local, insecure, and non-web icon URLs', () => {
    const page = document('<link rel="icon" type="text/html" href="https://example.com/not-an-image">'
      + '<link rel="icon" href="http://example.com/icon.png">'
      + '<link rel="icon" href="https://127.0.0.1/icon.png">'
      + '<link rel="icon" href="data:image/png;base64,AAA">'
      + '<link rel="icon" href="https://cdn.example.com/icon.png#fragment">');
    expect(discoverFaviconUrl(page, 'https://example.com/read')).toBe('https://cdn.example.com/icon.png');
  });
});
