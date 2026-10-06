/* global readingRecovery -- Bundled production Reading API and persistence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';

const { outputFiles } = await build({ stdin: { contents: `
  export { loadReading } from './src/pwa/reading/api';
  export { drainReading } from './src/pwa/reading/outbox';
  export * from './src/pwa/reading/storage';
  export { readingDatabase } from './src/pwa/reading/database';
  export { createReadingNote, parseReadingNote } from './src/reading/core/notes';
`, resolveDir: process.cwd() }, bundle: true, format: 'iife', globalName: 'readingRecovery', write: false });

for (const engine of [chromium, webkit]) test(`${engine.name()}: Reading source uncertainty and atomic offline refresh`, async () => {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reading recovery</title>' }));
    await page.goto('https://reading-recovery.test');
    await page.addScriptTag({ content: outputFiles[0].text });
    const result = await page.evaluate(async () => {
      const api = readingRecovery;
      const session = { id: 'recovery-session', token: 'test-token', generation: 'generation', folderPath: 'Reading', expiresAt: Date.now() + 86400000 };
      localStorage.setItem(api.READING_SESSION_KEY, JSON.stringify(session));
      const id = crypto.randomUUID();
      const item = { ...api.parseReadingNote(api.createReadingNote({ id, url: 'https://example.invalid/read', savedAt: new Date().toISOString() })), path: 'Reading/Note.md' };
      const key = `article:${session.id}:${id}`, listKey = `list:${session.id}`;
      const db = await api.readingDatabase();
      const seed = async () => {
        await api.cacheReadingArticle(session, item, 'The saved offline article.');
        await api.commitReadingCache(session, { items: [item], issues: [], savedAt: 1 });
      };
      let body = {}, status = 503;
      window.fetch = async path => path === '/reading/encryption' ? Response.json({ encryption: null }) : new Response(JSON.stringify(body), { status });
      await seed();
      let failed = false;
      try { await api.loadReading(session); } catch { failed = true; }
      const unavailable = { failed, article: !!await api.readReadingArticle(session, id), list: await api.readReadingCache(session) };

      // Older servers can return HTTP 200 with missing items and source issues.
      status = 200;
      body = { items: [], issues: [{ path: item.path, message: 'Source could not be read.' }], cursor: null };
      const uncertain = await api.loadReading(session);
      const retained = !!await api.readReadingArticle(session, id);

      // A healthy complete response still removes a genuinely deleted article.
      body = { items: [], issues: [], cursor: null };
      await api.loadReading(session);
      const deleted = await db.get('values', key) === undefined;

      // A late cache-write failure must roll back earlier article pruning too.
      await seed();
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, target) {
        if (target === listKey) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
        return put.call(this, value, target);
      };
      let writeFailed = false;
      try { await api.loadReading(session); } catch { writeFailed = true; }
      finally { IDBObjectStore.prototype.put = put; }
      const rollback = { writeFailed, article: !!await api.readReadingArticle(session, id), list: await api.readReadingCache(session) };

      // Malformed cached bytes remain exportable instead of being silently pruned.
      const damaged = `article:${session.id}:damaged`;
      await db.put('values', { markdown: 'Unvalidated recovery text' }, damaged);
      await api.loadReading(session);
      const damagedRetained = await db.get('values', damaged);
      return { id, unavailable, uncertain, retained, deleted, rollback, damagedRetained };
    });
    assert.equal(result.unavailable.failed, true);
    assert.equal(result.unavailable.article, true);
    assert.equal(result.unavailable.list.items[0].crate_reading_id, result.id);
    assert.equal(result.retained, true);
    assert.equal(result.uncertain.items[0].crate_reading_id, result.id);
    assert.equal(result.uncertain.issues.length, 1);
    assert.equal(result.deleted, true);
    assert.equal(result.rollback.writeFailed, true);
    assert.equal(result.rollback.article, true);
    assert.equal(result.rollback.list.savedAt, 1);
    assert.deepEqual(result.damagedRetained, { markdown: 'Unvalidated recovery text' });
  } finally { await browser.close(); }
});

for (const engine of [chromium, webkit]) test(`${engine.name()}: invalid Reading pagination preserves the durable revision and pending changes`, async () => {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reading pagination</title>' }));
    await page.goto('https://reading-pagination.test');
    await page.addScriptTag({ content: outputFiles[0].text });
    const results = await page.evaluate(async () => {
      const api = readingRecovery;
      const session = { id: 'pagination-session', token: 'test-token', generation: 'generation', folderPath: 'Reading', expiresAt: Date.now() + 86400000 };
      localStorage.setItem(api.READING_SESSION_KEY, JSON.stringify(session));
      const id = crypto.randomUUID();
      const item = { ...api.parseReadingNote(api.createReadingNote({ id, url: 'https://example.invalid/read', savedAt: new Date().toISOString() })), path: 'Reading/Saved.md' };
      const intent = { id, changes: { favorite: true }, before: { favorite: false } };
      const command = { id: crypto.randomUUID(), sessionId: session.id, action: 'update', intent,
        body: JSON.stringify({ ...intent, operationId: `e1_00020000_${crypto.randomUUID()}` }, null, 2) };
      await api.commitReadingCache(session, { items: [item], issues: [], savedAt: 1 });
      await api.cacheReadingArticle(session, item, 'Keep the previous offline article.');
      await api.savePendingReading(session, [command]);
      await api.saveReadingDraft(session, { url: 'https://example.invalid/unfinished-✓' });
      const db = await api.readingDatabase();
      const snapshot = async () => JSON.stringify({ keys: await db.getAllKeys('values'), values: await db.getAll('values') });
      const before = await snapshot();
      const issue = { path: 'Reading/Damaged.md', message: 'Source could not be read.' };
      const scenarios = [
        { name: 'malformed cursor', pages: [
          { items: [], issues: [], cursor: 'next' }, { items: [], issues: [], cursor: {} },
        ] },
        { name: 'cursor cycle', pages: ['A', 'B', 'A'].map(cursor => ({ items: [], issues: [], cursor })) },
        { name: 'terminal overflow', pages: [
          { items: [], issues: Array.from({ length: 10_000 }, () => issue), cursor: 'next' },
          { items: [], issues: [issue], cursor: null },
        ] },
        { name: 'acknowledged command with invalid list', drain: true, pages: [{ items: [], issues: [], cursor: {} }] },
      ];
      const results = [];
      for (const scenario of scenarios) {
        let lists = 0, mutations = 0;
        window.fetch = async path => {
          if (path === '/reading/encryption') return Response.json({ encryption: null });
          if (path === '/reading/session') return Response.json({ day: 20_000, generation: session.generation });
          if (path === '/reading/update') { mutations++; return Response.json({ saved: true }); }
          const response = scenario.pages[lists++];
          if (!response) throw new Error('Unexpected extra list request');
          return Response.json(response);
        };
        let error = null;
        try { await (scenario.drain ? api.drainReading(session) : api.loadReading(session)); }
        catch (cause) { error = cause.message; }
        results.push({ name: scenario.name, error, lists, mutations, unchanged: before === await snapshot() });
      }
      return results;
    });
    assert.deepEqual(results, [
      { name: 'malformed cursor', error: 'Reading library response is unreadable.', lists: 2, mutations: 0, unchanged: true },
      { name: 'cursor cycle', error: 'Reading library did not advance.', lists: 3, mutations: 0, unchanged: true },
      { name: 'terminal overflow', error: 'Reading library response is too large or unreadable.', lists: 2, mutations: 0, unchanged: true },
      { name: 'acknowledged command with invalid list', error: 'Reading library response is unreadable.', lists: 1, mutations: 1, unchanged: true },
    ]);
  } finally { await browser.close(); }
});
