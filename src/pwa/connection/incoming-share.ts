import { pendingReadingCapture, forgetReadingCapture } from '../encryption-fragments';
import { readingUrl } from '@/reading/core/model';

/** Preserve a Shortcut's private URL before any enrollment can reset in-memory keys. */
export async function preserveIncomingShare(current: () => boolean): Promise<void> {
  const incoming = pendingReadingCapture();
  if (!incoming) return;
  const { receiveReadingShare } = await import('@/cloudflare/worker/reading/share-target');
  if (!current()) return;
  const saved = await receiveReadingShare(new Request(location.origin + '/notifications/share/reading', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ url: readingUrl(incoming) }).toString(),
  }));
  if (saved.status !== 303) throw new Error(await saved.text());
  if (!current()) return;
  const url = new URL(location.href);
  url.searchParams.set('share', new URL(saved.headers.get('Location')!).searchParams.get('share')!);
  history.replaceState(history.state, '', url);
  forgetReadingCapture();
}
