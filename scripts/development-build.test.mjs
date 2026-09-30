import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevelopmentBuild } from './development-build.mjs';

test('requires a designated server and persists a counter across builds', () => {
  const root = mkdtempSync(join(tmpdir(), 'crate-dev-build-'));
  try {
    assert.throws(() => createDevelopmentBuild(root, ''), /CRATE_DEV_WORKER/);
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

test('loads the development Worker from local env files and honors shell overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'crate-dev-env-'));
  const previousWorker = process.env.CRATE_DEV_WORKER;
  try {
    delete process.env.CRATE_DEV_WORKER;
    mkdirSync(join(root, 'src/cloudflare'), { recursive: true });
    writeFileSync(join(root, 'src/cloudflare/server-release.json'), JSON.stringify({ revision: 3 }));
    assert.throws(() => createDevelopmentBuild(root), /\.env\.development\.local/);

    const localWorker = `crate-${'a'.repeat(16)}`;
    const shellWorker = `crate-${'b'.repeat(16)}`;
    writeFileSync(join(root, '.env'), `CRATE_DEV_WORKER=${shellWorker}\n`);
    writeFileSync(join(root, '.env.development.local'), `CRATE_DEV_WORKER="${localWorker}"\n`);
    assert.deepEqual(createDevelopmentBuild(root), { number: 1, worker: localWorker });

    // Re-read the file on each build so a running watcher can pick up changes.
    writeFileSync(join(root, '.env.development.local'), `CRATE_DEV_WORKER=${shellWorker}\n`);
    assert.deepEqual(createDevelopmentBuild(root), { number: 2, worker: shellWorker });
    process.env.CRATE_DEV_WORKER = localWorker;
    assert.deepEqual(createDevelopmentBuild(root), { number: 3, worker: localWorker });

    for (const worker of ['', 'crate-invalid', `https://${localWorker}.example.workers.dev`]) {
      process.env.CRATE_DEV_WORKER = worker;
      assert.throws(() => createDevelopmentBuild(root), /CRATE_DEV_WORKER/);
    }
    delete process.env.CRATE_DEV_WORKER;
    writeFileSync(join(root, '.env.development.local'), 'CRATE_DEV_WORKER=crate-invalid\n');
    assert.throws(() => createDevelopmentBuild(root), /CRATE_DEV_WORKER/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'server-development.local.json'), 'utf8')), { version: '3-dev.3' });
  } finally {
    if (previousWorker === undefined) delete process.env.CRATE_DEV_WORKER;
    else process.env.CRATE_DEV_WORKER = previousWorker;
    rmSync(root, { recursive: true, force: true });
  }
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
