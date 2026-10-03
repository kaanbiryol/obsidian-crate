import { expect, it } from 'vitest';
import { fetchArticle, fetchReadingCapture, extractionUrl, isPublicIPv4 } from './transport';

it('rejects private, metadata, reserved, encoded and non-web destinations before connecting', () => {
  for (const ip of ['127.0.0.1','0.0.0.0','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.100.100.200','192.0.0.8','198.18.0.1','203.0.113.1','255.255.255.255']) expect(isPublicIPv4(ip), ip).toBe(false);
  for (const url of ['http://127.1/','http://2130706433/','http://0x7f000001/','http://[::1]/','http://localhost/','http://router.local/','http://user:password@example.com/','https://example.com:8443/','file:///etc/passwd']) expect(() => extractionUrl(url), url).toThrow();
  expect(isPublicIPv4('8.8.8.8')).toBe(true); expect(extractionUrl('https://example.com/page#anchor').href).toBe('https://example.com/page');
});

it('fetches YouTube metadata through the public binding without a watch-page or player request', async () => {
  const seen: Request[] = [];
  const result = await fetchReadingCapture('https://youtu.be/jNQXAC9IVRw?t=42', async request => {
    seen.push(request);
    return Response.json({ type: 'video', title: 'A video', author_name: 'A channel', html: '<iframe>untrusted</iframe>' });
  });
  expect(result).toEqual({ article: { markdown: '', title: 'A video', author: 'A channel' }, url: 'https://youtu.be/jNQXAC9IVRw?t=42' });
  expect(seen).toHaveLength(1);
  expect(new URL(seen[0]!.url).pathname).toBe('/oembed');
  expect(new URL(seen[0]!.url).searchParams.get('url')).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw');
  expect(seen[0]!.credentials).toBe('omit');
  expect(seen[0]!.headers.get('Accept')).toBe('application/json');
});

it('bounds and validates metadata responses and every redirect', async () => {
  const source = 'https://youtube.com/shorts/jNQXAC9IVRw';
  await expect(fetchReadingCapture(source, async () => Response.redirect('http://127.0.0.1/'))).rejects.toThrow('Private');
  await expect(fetchReadingCapture(source, async () => new Response('x'.repeat(65537), { headers: { 'Content-Type': 'application/json' } }))).rejects.toThrow('large');
  await expect(fetchReadingCapture(source, async () => new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }))).rejects.toThrow('unavailable');
  await expect(fetchReadingCapture(source, async () => new Response('', { status: 404 }))).rejects.toThrow('unavailable');
});
it('bounds decoded bodies and revalidates redirects without passing credentials', async () => {
  const seen: Request[] = [];
  const fetcher = async (request: Request) => { seen.push(request); return new Response('<p>Article</p>', { headers: { 'Content-Type': 'text/html' } }); };
  expect((await fetchArticle('https://example.com/article', fetcher)).html).toContain('Article');
  expect(seen[0]!.redirect).toBe('manual'); expect(seen[0]!.headers.has('Authorization')).toBe(false);
  let calls = 0;
  await expect(fetchArticle('https://example.com/', async () => { calls++; return Response.redirect('http://127.0.0.1/', 302); })).rejects.toThrow('Private');
  expect(calls).toBe(1);
  await expect(fetchArticle('https://example.com/', async () => new Response('a'.repeat(2*1024*1024+1), { headers: {'Content-Type':'text/html'} }))).rejects.toThrow('large');
  await expect(fetchArticle('https://crate.example.com/', fetcher, 'https://crate.example.com')).rejects.toThrow('own server');
});
