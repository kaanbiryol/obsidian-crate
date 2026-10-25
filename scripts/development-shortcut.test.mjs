import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { developmentShortcut } from './development-shortcut.mjs';
import { shortcutName } from './shortcut-release.mjs';

async function withCache(run) {
  const cache = await mkdtemp(join(tmpdir(), 'crate-dev-shortcut-'));
  try { await run(cache); } finally { await rm(cache, { recursive: true, force: true }); }
}

test('signs each shortcut source revision once and reuses the cached file', () => withCache(async cache => {
  let signed = 0;
  const sign = (_root, directory) => {
    signed += 1;
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, shortcutName), 'AEA1signed');
  };
  const first = await developmentShortcut('.', { sign, cache, platform: 'darwin' });
  const second = await developmentShortcut('.', { sign, cache, platform: 'darwin' });
  assert.equal(Buffer.from(first, 'base64').toString(), 'AEA1signed');
  assert.equal(second, first);
  assert.equal(signed, 1);
}));

test('builds without a shortcut when signing is unavailable or fails', () => withCache(async cache => {
  const fail = () => { throw new Error('offline'); };
  assert.equal(await developmentShortcut('.', { sign: fail, cache, platform: 'linux' }), null);
  assert.equal(await developmentShortcut('.', { sign: fail, cache, platform: 'darwin' }), null);
}));
