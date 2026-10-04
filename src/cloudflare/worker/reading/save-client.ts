export interface ReadingSaveConfig {
  wireProtocol: number | null; serverRevision: number | null; serverFingerprint: string | null; pwaVersion: string | null;
  shortcutContract: number; shortcutRevision: number; downloadUrl: string; issuesUrl: string; supportOnly: boolean;
}

/** Self-contained browser entry: the Worker and public support page serialize
 * this same function. Keep runtime dependencies inside it or in the config. */
export function runReadingSavePage(config: ReadingSaveConfig): void {
  const key = 'crate-reading-handoff-v1', errorKey = 'crate-reading-handoff-error-v1';
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const title = element('title'), message = element('message'), retry = element<HTMLButtonElement>('retry');
  const progress = element('progress'), open = element<HTMLAnchorElement>('open'), support = element('support');
  const details = element<HTMLDetailsElement>('diagnostic-details'), field = element<HTMLTextAreaElement>('diagnostics');
  const copy = element<HTMLButtonElement>('copy'), copyStatus = element('copy-status'), issue = element<HTMLAnchorElement>('issue');
  const update = element('update'), download = element<HTMLAnchorElement>('download'), reconnect = element<HTMLAnchorElement>('reconnect');
  const reload = element<HTMLButtonElement>('reload');
  const number = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
  const codes = new Set(['reading_error', 'reading_not_configured', 'feature_paused', 'protocol_incompatible', 'server_update_required',
    'shortcut_update_required', 'shortcut_access_required', 'invalid_shortcut_request', 'invalid_response', 'request_failed',
    'network_error', 'save_link_expired', 'missing_save_link']);
  const normalize = (value: unknown): Record<string, unknown> => {
    const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    return { stage: typeof input.stage === 'string' && ['pair', 'prepare', 'handoff'].includes(input.stage) ? input.stage : 'handoff',
      code: typeof input.code === 'string' && codes.has(input.code) ? input.code : 'request_failed', status: number(input.status),
      requestId: typeof input.requestId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.requestId) ? input.requestId : null,
      serverRevision: number(input.serverRevision) ?? config.serverRevision,
      serverFingerprint: typeof input.serverFingerprint === 'string' && /^[a-f0-9]{64}$/.test(input.serverFingerprint) ? input.serverFingerprint : config.serverFingerprint,
      pwaVersion: typeof input.pwaVersion === 'string' && /^(?:[a-f0-9]{16}|dev)$/.test(input.pwaVersion) ? input.pwaVersion : config.pwaVersion,
      wireProtocol: number(input.wireProtocol) ?? config.wireProtocol,
      shortcutContract: number(input.shortcutContract) ?? config.shortcutContract,
      shortcutRevision: number(input.shortcutRevision) ?? 1 };
  };
  const query = new URLSearchParams(location.search);
  let shortcutRevision = number(Number(query.get('shortcut'))) || 1;
  let shortcutContract = number(Number(query.get('contract'))) || config.shortcutContract;
  const fragment = location.hash.slice(1);
  let token = /^[a-f0-9]{64}$/.test(fragment) && !config.supportOnly ? fragment : '';
  // Neither the capability nor error context belongs in browser history.
  history.replaceState(null, '', location.pathname);
  // A browser can reuse this sheet for another share without loading a new
  // document. Bootstrap the new fragment rather than displaying an old receipt.
  window.addEventListener('hashchange', () => { if (location.hash) location.reload(); });
  let incomingError: Record<string, unknown> | null = null;
  if (fragment.startsWith('error=')) {
    try { incomingError = normalize(fragment.length <= 4096 ? JSON.parse(decodeURIComponent(fragment.slice(6))) : { code: 'invalid_response' }); }
    catch { incomingError = normalize({ code: 'invalid_response' }); }
  }
  if (fragment && !token && !incomingError) incomingError = normalize({ code: 'missing_save_link' });
  const stored = (storageKey: string): Record<string, unknown> | null => {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  };
  try {
    if (incomingError) {
      sessionStorage.removeItem(key);
      sessionStorage.setItem(errorKey, JSON.stringify({ data: incomingError, until: Date.now() + 300000 }));
    }
    else if (token) {
      sessionStorage.removeItem(errorKey);
      sessionStorage.setItem(key, JSON.stringify({ token, until: Date.now() + 300000, shortcutRevision, shortcutContract }));
    } else if (!config.supportOnly) {
      const savedError = stored(errorKey);
      if (typeof savedError?.until === 'number' && savedError.until > Date.now()) incomingError = normalize(savedError.data);
      else {
        const saved = stored(key);
        if (typeof saved?.until === 'number' && saved.until > Date.now() && typeof saved.token === 'string' && /^[a-f0-9]{64}$/.test(saved.token)) {
          token = saved.token; shortcutRevision = number(saved.shortcutRevision) || 1; shortcutContract = number(saved.shortcutContract) || config.shortcutContract;
        }
      }
    }
  } catch { /* A valid fragment can still be committed without browser storage. */ }

  let busy = false, diagnostics = '';
  download.href = config.downloadUrl;
  reconnect.hidden = config.supportOnly;
  const updateAvailable = (required = false) => {
    update.hidden = !required && !config.supportOnly && shortcutRevision >= config.shortcutRevision;
    element('update-title').textContent = required ? 'Update your shortcut' : config.supportOnly ? 'Check your setup' : 'A newer shortcut is available';
    element('update-message').textContent = required || config.supportOnly ? 'Install Save to Crate, then create a new pairing code in Reading settings.' : 'Your existing shortcut can keep saving. The latest version adds clearer error reports and update guidance.';
  };
  const record = (input: Record<string, unknown>) => {
    const clean = normalize({ shortcutRevision, shortcutContract, ...input });
    const agent = navigator.userAgent;
    diagnostics = JSON.stringify({ format: 'crate-shortcut-diagnostics-v1', time: new Date().toISOString(), ...clean,
      browser: /CriOS|Chrome/.test(agent) ? 'Chrome' : /Firefox|FxiOS/.test(agent) ? 'Firefox' : /Safari/.test(agent) ? 'Safari' : 'Other',
      iosVersion: /(?:iPhone|iPad).*?OS (\d+(?:_\d+){0,2})/.exec(agent)?.[1]?.replace(/_/g, '.') ?? null }, null, 2);
    field.value = diagnostics;
    const url = new URL(config.issuesUrl);
    url.searchParams.set('title', 'Save to Crate shortcut failed');
    url.searchParams.set('body', 'What happened:\n\nPlease describe the steps and what you expected.\n\nDiagnostics (article URLs and access codes are excluded):\n\n```json\n' + diagnostics + '\n```');
    issue.href = url.href;
  };
  const failure = (input: Record<string, unknown>) => {
    const clean = normalize({ shortcutRevision, shortcutContract, ...input });
    const status = clean.status, code = clean.code;
    progress.hidden = true; open.hidden = true; support.hidden = false;
    retry.hidden = !token || clean.stage !== 'handoff' || [400, 401, 403, 409, 410, 413, 423, 426].includes(Number(status));
    reload.hidden = status !== 428;
    title.textContent = 'Save not confirmed';
    message.textContent = token ? 'The connection was interrupted. Retry to finish.' : 'Share the link again. If it keeps failing, check the diagnostics.';
    if (status === 401 || status === 403 && code === 'shortcut_access_required') {
      title.textContent = 'Reconnect your shortcut';
      message.textContent = 'In the Crate app, open Reading settings → Set up iPhone shortcut to create a new pairing code.';
    } else if (clean.stage !== 'pair' && (status === 410 || code === 'save_link_expired' || code === 'missing_save_link')) {
      title.textContent = 'Share this link again'; message.textContent = 'This link has expired or is missing. Share the article to Crate again.';
    } else if (status === 423) {
      title.textContent = 'Reading is paused'; message.textContent = 'Enable Reading in Crate settings, then share the article again.';
    } else if (code === 'server_update_required') {
      title.textContent = 'Update your Crate server'; message.textContent = 'Update the Crate plugin in Obsidian, then update the server in Crate settings. Share the article again when both updates finish.';
    } else if (code === 'shortcut_update_required') {
      title.textContent = 'Update your shortcut'; message.textContent = 'Install the latest Save to Crate shortcut and reconnect it to your library.';
    } else if (status === 428) {
      title.textContent = 'Reload this save page'; message.textContent = 'Your server was updated. Reload to finish this save.';
    } else if (status === 429) {
      message.textContent = 'Too many requests. Wait a moment, then retry.';
    } else if (status === 403) {
      message.textContent = 'Reading is not available for this connection. Check the Reading folder and access in Obsidian’s Crate settings.';
    } else if (config.supportOnly) {
      title.textContent = clean.stage === 'pair' ? 'Pairing did not finish' : 'Save not confirmed';
      message.textContent = 'The server did not return a usable save page. Update Crate in Obsidian and its server in Crate settings, then install the latest shortcut and reconnect it in the enrolled Crate app. Copy the diagnostics if it keeps failing.';
    } else if (clean.stage === 'pair') {
      title.textContent = 'Pairing did not finish'; message.textContent = 'Create a fresh pairing code in the Crate app and run shortcut setup again. Your previous connection has not been replaced.';
    }
    updateAvailable(code === 'shortcut_update_required');
    record(clean);
  };
  copy.addEventListener('click', () => {
    const payload = diagnostics;
    void (async () => {
      try {
        if (!navigator.clipboard) throw new Error('Unavailable');
        await navigator.clipboard.writeText(payload);
        if (diagnostics === payload) copyStatus.textContent = 'Diagnostics copied.';
      } catch {
        if (diagnostics !== payload) return;
        details.open = true; field.focus(); field.select(); copyStatus.textContent = 'Select and copy the diagnostics below.';
      }
    })();
  });
  reload.addEventListener('click', () => location.reload());
  async function save(): Promise<void> {
    if (busy) return;
    busy = true; retry.disabled = true; retry.hidden = true; progress.hidden = false;
    message.textContent = 'Keep this window open.';
    title.textContent = 'Saving…'; support.hidden = true; open.hidden = true;
    let status: number | null = null, requestId: string | null = null;
    try {
      const response = await fetch('/reading/handoff', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(20000),
        headers: { 'X-Crate-Capture': token, 'X-Crate-Protocol': String(config.wireProtocol), 'Content-Type': 'application/json' }, body: '{}' });
      status = response.status; requestId = response.headers.get('X-Crate-Request-Id');
      let data: Record<string, unknown>;
      try { data = await response.json() as Record<string, unknown>; }
      catch { failure({ stage: 'handoff', status, requestId, code: 'invalid_response' }); return; }
      if (!response.ok) { failure({ stage: 'handoff', status, requestId, code: data?.code }); return; }
      if (!data?.saved || typeof data.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data.id)) {
        failure({ stage: 'handoff', status, requestId, code: 'invalid_response' }); return;
      }
      title.textContent = data.alreadySaved ? 'Already saved' : 'Saved';
      message.textContent = 'You can close this window.';
      open.href = '/notifications?section=reading&item=' + encodeURIComponent(data.id); open.hidden = false;
      updateAvailable();
    } catch { failure({ stage: 'handoff', status, requestId, code: 'network_error' }); }
    finally { busy = false; retry.disabled = false; progress.hidden = true; }
  }
  retry.addEventListener('click', () => { void save(); });
  if (incomingError) {
    shortcutRevision = number(incomingError.shortcutRevision) || 1;
    shortcutContract = number(incomingError.shortcutContract) || config.shortcutContract;
    failure(incomingError);
  } else if (!token || config.supportOnly) failure({ stage: config.supportOnly ? 'prepare' : 'handoff', code: config.supportOnly ? 'invalid_response' : 'missing_save_link' });
  else void save();
}
