import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevelopmentBuild } from './development-build.mjs';

test('requires a designated server and persists a counter across builds', () => {
  const root = mkdtempSync(join(tmpdir(), 'crate-dev-build-'));
  try {
    assert.throws(() => createDevelopmentBuild(root), /CRATE_DEV_WORKER/);
    mkdirSync(join(root, 'src/cloudflare'), { recursive: true });
    writeFileSync(join(root, 'src/cloudflare/server-release.json'), JSON.stringify({ revision: 3 }));
    const worker = `crate-${'a'.repeat(16)}`;
    assert.deepEqual(createDevelopmentBuild(root, worker), { number: 1, worker });
    assert.deepEqual(createDevelopmentBuild(root, worker), { number: 2, worker });
    const local = join(root, 'server-development.local.json');
    assert.deepEqual(JSON.parse(readFileSync(local, 'utf8')), { version: '3-dev.2' });
    writeFileSync(local, JSON.stringify({ version: '3-dev.10' }));
    assert.equal(createDevelopmentBuild(root, worker).number, 11);
    writeFileSync(join(root, 'src/cloudflare/server-release.json'), JSON.stringify({ revision: 4 }));
    assert.equal(createDevelopmentBuild(root, worker).number, 1);
    assert.deepEqual(JSON.parse(readFileSync(local, 'utf8')), { version: '4-dev.1' });
    writeFileSync(local, '{');
    assert.throws(() => createDevelopmentBuild(root, worker));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses stale Worker bytes or a changed release manifest when packaging', async () => {
  const { createHash } = await import('node:crypto');
  const { readBuiltIdentity } = await import('./development-build.mjs');
  const root = mkdtempSync(join(tmpdir(), 'crate-build-identity-'));
  try {
    mkdirSync(join(root, 'src/cloudflare'), { recursive: true });
    mkdirSync(join(root, '.generated/cloudflare'), { recursive: true });
    const release = { revision: 3 };
    writeFileSync(join(root, 'src/cloudflare/server-release.json'), JSON.stringify(release));
    writeFileSync(join(root, '.generated/cloudflare/worker.mjs'), 'worker');
    const identity = { release, development: null, workerSha256: createHash('sha256').update('worker').digest('hex') };
    writeFileSync(join(root, '.generated/cloudflare/build-identity.json'), JSON.stringify(identity));
    assert.deepEqual(readBuiltIdentity(root), identity);
    writeFileSync(join(root, '.generated/cloudflare/worker.mjs'), 'other-worker');
    assert.throws(() => readBuiltIdentity(root), /stale/);
    writeFileSync(join(root, '.generated/cloudflare/worker.mjs'), 'worker');
    writeFileSync(join(root, 'src/cloudflare/server-release.json'), JSON.stringify({ revision: 4 }));
    assert.throws(() => readBuiltIdentity(root), /stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
