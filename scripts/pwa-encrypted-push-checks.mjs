import assert from 'node:assert/strict';
import { build } from 'esbuild';

/** The production push listener and crypto run inside an actual service worker.
 * Only push transport and native notification display are simulated. */
export async function buildEncryptedPushWorker() {
  const crypto = (await build({ entryPoints: ['src/pwa/encrypted-push.ts'], bundle: true,
    write: false, format: 'iife', globalName: 'crateEncryptedPush', platform: 'browser', target: 'es2022' })).outputFiles[0].text;
  const module = (await build({ entryPoints: ['src/cloudflare/worker/pwa/service-worker.ts'], bundle: true,
    write: false, format: 'esm', platform: 'node', target: 'es2022',
    define: { __CRATE_ENCRYPTED_PUSH_JS__: JSON.stringify(crypto), __CRATE_PWA_CLIENT_ASSETS__: '{}',
      __CRATE_PWA_ASSET_VERSION__: JSON.stringify('encrypted-push-test') },
  })).outputFiles[0].text;
  const { SERVICE_WORKER_JS } = await import(`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`);
  return `
let receivePush, shownNotification;
const addListener = self.addEventListener.bind(self);
self.addEventListener = (name, listener, options) => {
  if (name === 'push') receivePush = listener;
  addListener(name, listener, options);
};
self.registration.showNotification = async (title, options) => {
  // Match WebKit's requirement for replacing a declarative notification.
  if (!options.navigate || new URL(options.navigate).origin !== location.origin) throw new Error('Missing notification navigation');
  shownNotification = { title, ...options };
};
${SERVICE_WORKER_JS}
addListener('message', event => {
  if (event.data?.type !== 'test-encrypted-push') return;
  let complete;
  shownNotification = undefined;
  const notification = event.data.notification;
  receivePush({
    ...(event.data.declarative ? { data: null, notification: Object.create(notification) }
      : { data: { json: () => ({ notification }) } }),
    waitUntil(work) { complete = work; },
  });
  event.waitUntil(Promise.resolve(complete).then(() => event.ports[0].postMessage(shownNotification),
    error => event.ports[0].postMessage({ error: error.message })));
});`;
}

export async function verifyEncryptedPushWorker(page, origin) {
  const result = await page.evaluate(async origin => {
    const t = window.encryptionStorageTest;
    const bundle = t.addReminderScope(t.createVaultKeyBundle(), 'Reminders');
    const grant = t.createReminderKeyGrant(bundle, 'Reminders');
    await t.rememberReminderKeys(grant);
    const projection = await t.createReminderProjection(bundle, 'Reminders/Inbox.md',
      new TextEncoder().encode('- [ ] Private background title 2099-01-02 <!-- crate-id:background-push -->').buffer);
    const notice = projection.reminders[0].notification;
    const registration = await navigator.serviceWorker.register('/encrypted-push-worker.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const notification = { title: 'Crate reminder', body: 'Open Crate to view your reminder.',
      navigate: origin + '/notifications?reminderId=background-push', tag: 'background-push',
      data: { encrypted: notice, project: '', reminderId: 'background-push' } };
    async function deliver(declarative, value = notification) {
      const channel = new MessageChannel();
      try {
        return await new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error('Background push did not settle')), 10_000);
          channel.port1.onmessage = event => { clearTimeout(deadline); resolve(event.data); };
          registration.active.postMessage({ type: 'test-encrypted-push', declarative, notification: value }, [channel.port2]);
        });
      } finally { channel.port1.close(); }
    }
    try {
      const declarative = await deliver(true);
      const legacy = await deliver(false);
      const substituted = await deliver(true, { ...notification, data: { ...notification.data,
        encrypted: { ...notice, reminderId: 'substitution' } } });
      await t.clearReminderKeys(() => true);
      const locked = await deliver(true);
      return { declarative, legacy, substituted, locked, navigate: notification.navigate };
    } finally { await registration.unregister(); }
  }, origin);
  for (const display of [result.declarative, result.legacy]) {
    assert.equal(display.title, 'Private background title');
    assert.equal(display.body, 'Inbox');
    assert.equal(display.navigate, result.navigate);
    assert.equal(display.data.reminderId, 'background-push');
    assert.equal(display.data.navigate, result.navigate);
  }
  for (const display of [result.substituted, result.locked]) {
    assert.equal(display.title, 'Crate reminder');
    assert.equal(display.body, 'Open Crate to view your reminder');
    assert.equal(display.navigate, result.navigate);
  }
}
