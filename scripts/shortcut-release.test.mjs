import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetName, metadataName, shortcutName, selectRelease, sha256, validateTag, verifyShortcut } from './shortcut-release.mjs';
import { downloadShortcut } from './download-release-shortcut.mjs';

const release = (tag, published, overrides = {}) => ({ tag_name: tag, published_at: published, draft: false, assets: [{ name: assetName }, { name: metadataName }], ...overrides });
const bytes = Buffer.from('AEA1test archive');
const metadata = () => ({ format: 1, tag: '0.4.0', file: assetName, sha256: sha256(bytes), sourceSha256: 'source' });

test('Pages selects the most recently published shortcut, including prereleases, but excludes drafts and plugin-only releases', () => {
  const selected = release('0.4.0', '2026-09-28', { prerelease: true });
  assert.equal(selectRelease([
    release('0.5.0', '2026-09-30', { draft: true }),
    release('0.6.0', '2026-10-01', { assets: [] }),
    release('0.3.0', '2026-09-20'), selected,
  ]), selected);
});
test('an incomplete newer shortcut release fails instead of silently serving an old shortcut', () => {
  assert.throws(() => selectRelease([release('0.4.0', '2026-09-28', { assets: [{ name: metadataName }] })]), /missing/);
  assert.throws(() => selectRelease([]), /No release/);
});

test('release verification selects only the requested draft tag', () => {
  const draft = release('0.4.0', null, { draft: true });
  assert.equal(selectRelease([release('0.3.0', '2026-09-20'), draft], '0.4.0'), draft);
  assert.throws(() => selectRelease([draft], '0.5.0'), /No release/);
});
test('corrupted bytes and stale source are rejected', () => {
  verifyShortcut(metadata(), bytes, '0.4.0', 'source');
  assert.throws(() => verifyShortcut(metadata(), Buffer.concat([bytes, Buffer.from('tampered')]), '0.4.0'), /checksum/);
  assert.throws(() => verifyShortcut(metadata(), bytes, '0.4.0', 'changed source'), /different source/);
});
test('unsigned files and mismatched metadata cannot be published', () => {
  const unsigned = Buffer.from('bplist00');
  assert.throws(() => verifyShortcut({ ...metadata(), sha256: sha256(unsigned) }, unsigned, '0.4.0'), /signed shortcut/);
  for (const change of [{ format: 2 }, { tag: '0.3.0' }, { file: '../other.shortcut' }]) {
    assert.throws(() => verifyShortcut({ ...metadata(), ...change }, bytes, '0.4.0'), /metadata/);
  }
});
test('release tags cannot be flags, paths, or prefixed versions', () => {
  for (const tag of ['0.4.0', '0.4.0-beta.1']) validateTag(tag);
  for (const tag of [undefined, '--clobber', '../main', 'v0.4.0', '']) assert.throws(() => validateTag(tag), /version/);
});

test('the install page tolerates only an absent published version, never a partial release', () => {
  const options = { allowMissing: true };
  const draft = release('0.4.0', null, { draft: true });
  assert.equal(selectRelease([draft], undefined, undefined, options), null);
  assert.throws(() => selectRelease([], '0.4.0', undefined, options), /No release/);
  for (const name of [assetName, metadataName]) {
    assert.throws(() => selectRelease([release('0.4.0', '2026-09-28', { assets: [{ name }] })], undefined, undefined, options), /missing/);
  }
});

async function downloadFixture(t, items, overrides = {}) {
  const destination = await mkdtemp(join(tmpdir(), 'crate-shortcut-install-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const dependencies = { getReleases: () => items,
    downloadRelease: async (_tag, names, directory) => {
      await writeFile(join(directory, names.assetName), bytes);
      await writeFile(join(directory, names.metadataName), JSON.stringify(metadata()));
    }, ...overrides };
  return { destination, dependencies, run: () => downloadShortcut(['published', destination, '--install-page'], dependencies) };
}

test('Pages serves an unavailable page without reusing the legacy shortcut or a stale local file', async t => {
  const legacy = release('0.3.0', '2026-09-20', { assets: [{ name: 'save-to-crate-ios-27.shortcut' }, { name: 'reading-shortcut.json' }] });
  const f = await downloadFixture(t, [legacy], { downloadRelease: () => assert.fail('No v2 asset should be downloaded') });
  await writeFile(join(f.destination, shortcutName), 'stale artifact');
  await f.run();
  const page = await readFile(join(f.destination, 'index.html'), 'utf8');
  assert.match(page, /not available yet/);
  assert.doesNotMatch(page, /href="[^"]*\.shortcut"/);
  await assert.rejects(readFile(join(f.destination, shortcutName)), { code: 'ENOENT' });
  await assert.rejects(downloadShortcut(['published', f.destination], f.dependencies), /No release/);
});

test('Pages offers the verified download when v2 is published', async t => {
  const f = await downloadFixture(t, [release('0.4.0', '2026-09-28')]);
  await f.run();
  assert.deepEqual(await readFile(join(f.destination, shortcutName)), bytes);
  const page = await readFile(join(f.destination, 'index.html'), 'utf8');
  assert.match(page, /Download shortcut/);
  assert.ok(page.includes(`href="./${encodeURIComponent(shortcutName)}"`));
  assert.doesNotMatch(page, /not available yet/);
});

test('Pages fails on network errors and corrupt artifacts instead of hiding them as unavailable', async t => {
  for (const stage of ['list', 'download', 'checksum']) {
    const f = await downloadFixture(t, [release('0.4.0', '2026-09-28')], {
      ...(stage === 'list' ? { getReleases: () => { throw new Error('Network failed'); } } : {}),
      downloadRelease: async (_tag, names, directory) => {
        if (stage === 'download') throw new Error('Network failed');
        await writeFile(join(directory, names.assetName), Buffer.concat([bytes, Buffer.from('corrupt')]));
        await writeFile(join(directory, names.metadataName), JSON.stringify(metadata()));
      },
    });
    await assert.rejects(f.run(), /failed|checksum/);
    await assert.rejects(readFile(join(f.destination, 'index.html')), { code: 'ENOENT' });
  }
});

test('the optional install page cannot weaken draft or explicit-tag verification', async () => {
  for (const args of [['draft', 'unused', '0.4.0', '--install-page'], ['published', 'unused', '0.4.0', '--install-page'], ['published', 'unused', '--legacy', '--install-page']]) {
    await assert.rejects(downloadShortcut(args, { getReleases: () => assert.fail('Invalid arguments must not query GitHub') }), /Usage/);
  }
});
