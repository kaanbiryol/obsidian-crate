import { DOMParser } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { captureDesktopArticle } from './desktop-capture';

beforeEach(() => { vi.stubGlobal('window', { DOMParser, setTimeout: (callback: () => void, delay?: number) => setTimeout(callback, delay), clearTimeout: (id: number) => clearTimeout(id) }); });
vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));
const html = '<html><head><title>Local article</title></head><body><article><h1>Local article</h1><p>A useful article with enough text to extract, keep locally, and read again without a server connection.</p><script>window.bad = true</script><img src="https://tracking.example.org/pixel"><p>Read <a href="/next">the next article</a> at your own pace.</p></article></body></html>';
const response = (body = html, status = 200, contentType = 'text/html; charset=utf-8') => ({ status, headers: { 'Content-Type': contentType }, arrayBuffer: new TextEncoder().encode(body).buffer, text: body, json: null });
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('desktop article capture', () => {
  it('keeps public metadata when the optional transcript is unavailable', async () => {
    vi.mocked(requestUrl).mockResolvedValue(response('{"type":"video","title":"A video","author_name":"Channel"}', 200, 'application/json'));
    expect(await captureDesktopArticle('https://youtu.be/jNQXAC9IVRw?t=42', new AbortController().signal)).toEqual({ markdown: '', title: 'A video', author: 'Channel' });
    expect(requestUrl).toHaveBeenCalledTimes(2);
    expect(vi.mocked(requestUrl).mock.calls[0]![0]).toMatchObject({ url: 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjNQXAC9IVRw&format=json', headers: { Accept: 'application/json' } });
  });
  it('rejects oversized or unavailable video details while allowing the caller to retain its bookmark', async () => {
    vi.mocked(requestUrl).mockResolvedValue(response('x'.repeat(65537), 200, 'application/json'));
    await expect(captureDesktopArticle('https://youtu.be/jNQXAC9IVRw', new AbortController().signal)).rejects.toThrow('Video details');
    vi.mocked(requestUrl).mockResolvedValue(response('', 404, 'application/json'));
    await expect(captureDesktopArticle('https://youtu.be/jNQXAC9IVRw', new AbortController().signal)).rejects.toThrow('Video details');
  });
  it('uses native HTTP and extracts inert HTML without extra network requests', async () => {
    vi.mocked(requestUrl).mockResolvedValue(response());
    const fetch = vi.fn(() => { throw new Error('No extractor network requests'); });
    vi.stubGlobal('fetch', fetch);
    const article = await captureDesktopArticle('https://example.com/article', new AbortController().signal);
    expect(article.title).toBe('Local article');
    expect(article.markdown).toContain('[the next article](https://example.com/next)');
    expect(article.markdown).not.toContain('tracking.example.org');
    expect(article.markdown).not.toContain('window.bad');
    expect(fetch).not.toHaveBeenCalled();
    expect(requestUrl).toHaveBeenCalledExactlyOnceWith({ url: 'https://example.com/article', method: 'GET', throw: false, headers: { Accept: 'text/html, application/xhtml+xml' } });
  });
  it.each(['file:///private/note', 'https://user:password@example.com', 'http://127.0.0.1/', 'http://192.168.1.1/', 'https://site.local/'])('rejects unsupported source %s before requesting it', async url => {
    await expect(captureDesktopArticle(url, new AbortController().signal)).rejects.toThrow();
    expect(requestUrl).not.toHaveBeenCalled();
  });
  it.each([[403, 'text/html'], [200, 'application/pdf']] as const)('rejects status %s and type %s', async (status, type) => {
    vi.mocked(requestUrl).mockResolvedValue(response(html, status, type));
    await expect(captureDesktopArticle('https://example.com', new AbortController().signal)).rejects.toThrow('readable article');
  });
  it('checks the buffered response limit before extraction', async () => {
    vi.mocked(requestUrl).mockResolvedValue(response('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(captureDesktopArticle('https://example.com', new AbortController().signal)).rejects.toThrow('2 MB');
  });
  it('decodes the response charset', async () => {
    const page = response(html.replace('Local article', 'Café article'), 200, 'text/html; charset=windows-1252');
    page.arrayBuffer = Uint8Array.from(page.text, character => character.charCodeAt(0)).buffer;
    vi.mocked(requestUrl).mockResolvedValue(page);
    expect((await captureDesktopArticle('https://example.com', new AbortController().signal)).title).toBe('Café article');
  });
  it('times out and ignores a native download that resolves later', async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof response>>();
    vi.mocked(requestUrl).mockReturnValue(pending.promise as unknown as ReturnType<typeof requestUrl>);
    const work = captureDesktopArticle('https://example.com', new AbortController().signal);
    const check = expect(work).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15_000); await check;
    pending.resolve(response());
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops waiting on unload and does not process a late response', async () => {
    const controller = new AbortController(), pending = deferred<ReturnType<typeof response>>();
    vi.mocked(requestUrl).mockReturnValue(pending.promise as unknown as ReturnType<typeof requestUrl>);
    const work = captureDesktopArticle('https://example.com', controller.signal);
    controller.abort();
    await expect(work).rejects.toThrow();
    pending.resolve(response());
    await expect(captureDesktopArticle('https://example.com', controller.signal)).rejects.toThrow();
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
