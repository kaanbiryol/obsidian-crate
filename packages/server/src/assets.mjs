import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
// Only the packager sets this marker. Source modules use repository assets;
// installed modules must use the shipped assets and never fall back to a checkout.
export const packaged = metadata.crateServerAssets === true;
export const runtimeRoot = packaged ? packageRoot : resolve(packageRoot, '../..');
const runtimePackage = packaged ? metadata : JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8'));
export const runtimeVersion = runtimePackage.crateServerRuntime ?? runtimePackage.devDependencies.miniflare;
export const serverAssetPath = name => join(runtimeRoot, packaged ? 'assets' : 'src/cloudflare', name);
export const workerPath = packaged ? serverAssetPath('worker.mjs') : join(runtimeRoot, '.generated/cloudflare/worker.mjs');
