import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetName, metadataName, selectRelease, sha256, validateTag, verifyShortcut } from './shortcut-release.mjs';

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
