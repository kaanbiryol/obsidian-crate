import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const shortcutName = 'Save to Crate (iOS 27).shortcut';
export const assetName = 'save-to-crate-ios-27-v2.shortcut';
export const legacyAssetName = 'save-to-crate-ios-27.shortcut';
export const metadataName = 'reading-shortcut-v2.json';
export const legacyMetadataName = 'reading-shortcut.json';
const sources = ['docs/shortcuts/save-to-crate.plist', 'src/reading/shortcut-contract.json', 'scripts/reading-shortcut-template.mjs', 'scripts/reading-shortcut-first-run.mjs', 'scripts/sign-reading-shortcut.mjs'];

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const gh = args => execFileSync('gh', args, { encoding: 'utf8' }).trim();
export const releases = () => JSON.parse(gh(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/releases?per_page=100'])).flat();
export async function sourceHash(root = '.') {
  const inputs = [];
  for (const path of sources) inputs.push([path, sha256(await readFile(resolve(root, path)))]);
  return sha256(JSON.stringify(inputs));
}
export function validateTag(tag) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? '')) throw new Error('Supply a release version, without a leading v.');
}
export function selectRelease(items, tag, names = { assetName, metadataName }, { allowMissing = false } = {}) {
  const release = tag ? items.find(item => item.tag_name === tag) : items
    .filter(item => !item.draft && item.assets.some(asset => [names.assetName, names.metadataName].includes(asset.name)))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (!release && !tag && allowMissing) return null;
  if (!release) throw new Error('No release with a prepared shortcut was found. Run npm run release:prepare first.');
  for (const name of [names.assetName, names.metadataName]) {
    if (!release.assets.some(asset => asset.name === name)) throw new Error(`Release ${release.tag_name} is missing ${name}.`);
  }
  return release;
}
export function verifyShortcut(metadata, bytes, tag, expectedSource, expectedAsset = assetName) {
  if (metadata.format !== 1 || metadata.tag !== tag || metadata.file !== expectedAsset) throw new Error('Shortcut release metadata does not match the requested release.');
  if (bytes.subarray(0, 4).toString() !== 'AEA1') throw new Error('Expected an Apple signed shortcut archive.');
  if (metadata.sha256 !== sha256(bytes)) throw new Error('Shortcut checksum mismatch.');
  if (expectedSource && metadata.sourceSha256 !== expectedSource) throw new Error('Shortcut was signed from different source files.');
}
