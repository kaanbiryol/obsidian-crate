/** Removes named values from the URL fragment, which never travels in HTTP
 * requests, cookies, manifests or referrers, and returns those present. */
export function takeFragmentValues<Name extends string>(names: readonly Name[]): Partial<Record<Name, string>> {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const values: Partial<Record<Name, string>> = {};
  for (const name of names) {
    const value = fragment.get(name);
    if (value !== null) values[name] = value;
  }
  if (!names.some(name => fragment.has(name))) return values;
  for (const name of names) fragment.delete(name);
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + (fragment.size ? '#' + fragment.toString() : ''));
  return values;
}

let readingCapture: string | undefined;
export const pendingReadingCapture = () => readingCapture;
export function forgetReadingCapture(): void { readingCapture = undefined; }
let readingKey: string | undefined;
export function consumeReadingKeyFragment(): void {
  const values = takeFragmentValues(['readingCapture', 'crateReadingKey']);
  readingCapture = values.readingCapture ?? readingCapture;
  readingKey = values.crateReadingKey ?? readingKey;
}
export const pendingReadingKey = () => readingKey;
export function forgetReadingKey(): void { readingKey = undefined; }
