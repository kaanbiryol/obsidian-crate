import { describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createMarkdownContent } from 'defuddle/full';
import { articleMarkdown } from './markdown';

vi.mock('defuddle/full', () => ({ createMarkdownContent: vi.fn() }));

describe('Defuddle conversion failure', () => {
  it('rejects upstream HTML fallback without exposing article content in the error', () => {
    const document = parseHTML('<html><body><p>Private article text</p></body></html>').document;
    vi.mocked(createMarkdownContent).mockReturnValue('Partial conversion completed with errors. Original HTML:\n\n<p>Private article text</p>');
    expect(() => articleMarkdown(document.body as unknown as HTMLElement, 'https://example.com/'))
      .toThrow('Article Markdown conversion failed');
  });
});
