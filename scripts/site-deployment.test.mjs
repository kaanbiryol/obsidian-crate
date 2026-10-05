import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploymentFile, prepareSiteDeployment, siteFingerprint } from './site-deployment.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'crate-site-deployment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.html'), '<h1>Crate</h1>');
  return directory;
}
const options = directory => ({ directory, previousUrl: 'https://example.invalid/deployment.json', commit: 'release-commit' });
const response = fingerprint => Response.json({ format: 1, fingerprint, commit: 'previous-commit' });

test('unchanged built content skips deployment even when commit and metadata change', async t => {
  const directory = await fixture(t);
  const fingerprint = await siteFingerprint(directory);
  await writeFile(join(directory, deploymentFile), '{"commit":"old"}');
  const result = await prepareSiteDeployment({ ...options(directory), request: async () => response(fingerprint) });
  assert.equal(result.deploy, false);
  assert.equal(await siteFingerprint(directory), fingerprint);
  assert.deepEqual(JSON.parse(await readFile(join(directory, deploymentFile))), { format: 1, fingerprint, commit: 'release-commit' });
});

test('generated pages and binary shortcut additions, replacements, renames and removals trigger deployment', async t => {
  const directory = await fixture(t);
  let deployed = await siteFingerprint(directory);
  const changed = async () => {
    const result = await prepareSiteDeployment({ ...options(directory), request: async () => response(deployed) });
    assert.equal(result.deploy, true);
    deployed = result.fingerprint;
  };
  await mkdir(join(directory, 'docs'));
  await writeFile(join(directory, 'docs/index.html'), '<h1>Docs</h1>');
  await changed();
  const shortcut = join(directory, 'Save to Crate.shortcut');
  await writeFile(shortcut, Buffer.from([0, 1, 2]));
  await changed();
  await writeFile(shortcut, Buffer.from([0, 1, 3]));
  await changed();
  await rename(shortcut, join(directory, 'renamed.shortcut'));
  await changed();
  await rm(join(directory, 'renamed.shortcut'));
  await changed();
});

test('a missing baseline establishes the first deployment and bypasses cached metadata', async t => {
  const directory = await fixture(t);
  const result = await prepareSiteDeployment({ ...options(directory), request: async (url, init) => {
    assert.ok(url.searchParams.has('check'));
    assert.equal(init.cache, 'no-store');
    return new Response('', { status: 404 });
  } });
  assert.equal(result.deploy, true);
});

test('network errors and invalid metadata fail instead of silently skipping or deploying', async t => {
  const directory = await fixture(t);
  for (const request of [
    async () => { throw new Error('Network unavailable'); },
    async () => new Response('', { status: 503 }),
    async () => Response.json({ format: 1, fingerprint: 'invalid' }),
    async () => Response.json({ format: 2, fingerprint: 'a'.repeat(64) }),
  ]) await assert.rejects(prepareSiteDeployment({ ...options(directory), request }));
});

test('manual deployment can recover without readable metadata', async t => {
  const directory = await fixture(t);
  const result = await prepareSiteDeployment({ ...options(directory), force: true, request: async () => {
    assert.fail('A forced deployment must not depend on live metadata');
  } });
  assert.equal(result.deploy, true);
  assert.equal(JSON.parse(await readFile(join(directory, deploymentFile))).fingerprint, result.fingerprint);
});

test('empty output cannot replace the live website', async t => {
  const directory = await fixture(t);
  await rm(join(directory, 'index.html'));
  await assert.rejects(siteFingerprint(directory), /empty website/);
});
