import { afterEach, expect, it, vi } from 'vitest';
import { captureBrowserArticle } from './capture-article';

afterEach(() => { vi.unstubAllGlobals(); });

it('fetches video metadata directly without credentials, referrers or a Crate proxy', async () => {
  const fetch = vi.fn(async () => Response.json({ type: 'video', title: 'A video', author_name: 'A channel', html: '<iframe>ignored</iframe>' }));
  vi.stubGlobal('fetch', fetch);
  expect(await captureBrowserArticle('https://youtu.be/jNQXAC9IVRw?t=42')).toEqual({ markdown: '', title: 'A video', author: 'A channel', deferTranscript: true });
  expect(fetch).toHaveBeenNthCalledWith(1, 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjNQXAC9IVRw&format=json', expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', headers: { Accept: 'application/json' } }));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((fetch.mock.calls[1] as unknown as [Request])[0]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
});

it('leaves a CORS-blocked capture for the existing encrypted pending-bookmark flow', async () => {
  const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
  vi.stubGlobal('fetch', fetch);
  await expect(captureBrowserArticle('https://youtu.be/jNQXAC9IVRw')).rejects.toThrow('Failed to fetch');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('bounds metadata downloads and rejects HTML responses', async () => {
  const fetch = vi.fn(async () => new Response('x'.repeat(65537), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  await expect(captureBrowserArticle('https://youtu.be/jNQXAC9IVRw')).rejects.toThrow('download limit');
  fetch.mockImplementation(async () => new Response('<p>Sign in</p>', { headers: { 'Content-Type': 'text/html' } }));
  await expect(captureBrowserArticle('https://youtu.be/jNQXAC9IVRw')).rejects.toThrow('Video details');
});
