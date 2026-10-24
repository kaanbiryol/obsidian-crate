import { expect, it, vi } from 'vitest';
import { captureServerArticle } from './capture-article';

it('sends only the link in the request body and keeps validated article fields', async () => {
  const request = vi.fn(async () => Response.json({ article: { markdown: 'Body', title: 'Title', author: 'Author', faviconUrl: 'https://example.com/icon.png', extra: 'ignored' } }));
  expect(await captureServerArticle('https://example.com/a', request)).toEqual({ markdown: 'Body', title: 'Title', author: 'Author', faviconUrl: 'https://example.com/icon.png' });
  expect(request).toHaveBeenCalledWith(JSON.stringify({ url: 'https://example.com/a' }));
});

it('keeps video details and transcripts as returned', async () => {
  const request = vi.fn(async () => Response.json({ article: { markdown: '', title: 'A video', author: 'A channel' } }));
  expect(await captureServerArticle('https://youtu.be/jNQXAC9IVRw?t=42', request)).toEqual({ markdown: '', title: 'A video', author: 'A channel' });
  request.mockImplementation(async () => Response.json({ article: { markdown: '**0:02** Hello', transcript: { source: 'youtube', language: 'en' } } }));
  expect(await captureServerArticle('https://youtu.be/jNQXAC9IVRw', request)).toEqual({ markdown: '**0:02** Hello', transcript: { source: 'youtube', language: 'en' } });
});

it('rejects failed downloads and malformed articles', async () => {
  const request = vi.fn(async () => Response.json({ error: 'This article could not be downloaded.' }, { status: 422 }));
  await expect(captureServerArticle('https://example.com/a', request)).rejects.toThrow('Article download unavailable.');
  for (const article of [undefined, { markdown: 1 }, { markdown: '', title: 2 }, { markdown: '', transcript: { source: 'vimeo' } }]) {
    request.mockImplementation(async () => Response.json({ article }));
    await expect(captureServerArticle('https://example.com/a', request)).rejects.toThrow('Article download unavailable.');
  }
});
