import statusStyles from '../../../../site/assets/status.css?raw-css';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol';
import { READING_SHORTCUT_CONTRACT as contract } from '@/reading/shortcut';
import release from '../../server-release.json';
import { PWA_ASSET_VERSION } from '../pwa-version';
import { runReadingSavePage, type ReadingSaveConfig } from './save-client';

const pageHeaders = (type: string) => ({ 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https://crate.kaanbiryol.com; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
interface PageOptions { supportOnly?: boolean; scriptUrl?: string; serverFingerprint?: string }

export function readingSavePage({ supportOnly = false, scriptUrl = '/notifications/save-reading.js' }: PageOptions = {}): Response {
  const logo = supportOnly ? 'https://crate.kaanbiryol.com/assets/logo.png' : '/notifications/crate-mark-256.png';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="referrer" content="no-referrer"><title>Save to Crate</title><style>
  ${statusStyles}
  </style></head><body><main><div class="brand-lockup"><img src="${logo}" alt="Crate"></div><div class="spinner" id="progress" aria-hidden="true"></div><h1 id="title">Saving…</h1><p id="message" role="status" aria-live="polite">Keep this window open.</p>
  <div class="actions"><button id="retry" hidden>Retry save</button><button id="reload" hidden>Reload save page</button><a class="action" id="open" href="/notifications?section=reading" hidden>Open Reading</a></div>
  <section id="update" aria-labelledby="update-title" hidden><h2 id="update-title">Update your shortcut</h2><p id="update-message"></p><div class="actions"><a class="action secondary" id="download" href="${contract.downloadUrl}" target="_blank" rel="noopener noreferrer">Download shortcut</a><a class="action secondary" id="reconnect" href="/notifications?section=reading&amp;setup=shortcut">Open shortcut setup</a></div><p class="small">Install in Shortcuts, then create a pairing code in the enrolled Crate app’s Reading settings. Updates are installed by you.</p></section>
  <details id="support" hidden><summary>Help and diagnostics</summary><div class="actions"><button class="secondary" id="copy">Copy diagnostics</button><a class="action secondary" id="issue" href="${contract.issuesUrl}" target="_blank" rel="noopener noreferrer">Report on GitHub</a></div><p id="copy-status" role="status" class="small"></p><details id="diagnostic-details"><summary>View diagnostics</summary><label for="diagnostics">Diagnostics</label><textarea id="diagnostics" readonly spellcheck="false" autocapitalize="none"></textarea></details><p class="small">Article URLs, pairing codes, and access credentials are excluded. You can review the issue before submitting it.</p></details>
  <noscript><p>This save has not been confirmed. Enable JavaScript or share the article again.</p></noscript></main><script src="${scriptUrl}" defer></script></body></html>`, { headers: pageHeaders('text/html; charset=utf-8') });
}

export function readingSaveScript({ supportOnly = false, serverFingerprint }: PageOptions = {}): Response {
  const config: ReadingSaveConfig = { wireProtocol: supportOnly ? null : CRATE_PLUGIN_PROTOCOL.current,
    serverRevision: supportOnly ? null : release.revision,
    serverFingerprint: !supportOnly && serverFingerprint && /^[a-f0-9]{64}$/.test(serverFingerprint) ? serverFingerprint : null,
    pwaVersion: supportOnly ? null : PWA_ASSET_VERSION,
    shortcutContract: contract.version, shortcutRevision: contract.revision, downloadUrl: contract.downloadUrl, issuesUrl: contract.issuesUrl, supportOnly };
  return new Response(`(${runReadingSavePage.toString()})(${JSON.stringify(config)});`, { headers: pageHeaders('application/javascript') });
}
