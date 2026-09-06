// Provider-owned Web Push services. Redirects are rejected at delivery as well.
export function isValidPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    const host = url.hostname;
    return host === 'fcm.googleapis.com'
      || host === 'updates.push.services.mozilla.com'
      || host.endsWith('.push.apple.com')
      || host.endsWith('.notify.windows.com');
  } catch { return false; }
}
