let readingCapture: string | undefined;
export const pendingReadingCapture = () => readingCapture;
export function forgetReadingCapture(): void { readingCapture = undefined; }
let readingKey: string | undefined;
export function consumeReadingKeyFragment(): void {
  const fragment = new URLSearchParams(location.hash.slice(1));
  readingCapture = fragment.get('readingCapture') ?? readingCapture;
  const hasCapture = fragment.has('readingCapture');
  fragment.delete('readingCapture');
  readingKey = fragment.get('crateReadingKey') ?? readingKey;
  if (!fragment.has('crateReadingKey') && !hasCapture) return;
  fragment.delete('crateReadingKey');
  history.replaceState(history.state, '', location.pathname + location.search + (fragment.size ? '#' + fragment.toString() : ''));
}
export const pendingReadingKey = () => readingKey;
export function forgetReadingKey(): void { readingKey = undefined; }
