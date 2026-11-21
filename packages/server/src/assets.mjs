import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
// Only the packager sets this marker. Source modules use repository assets;
// installed modules must use the shipped assets and never fall back to a checkout.
export const packaged = metadata.crateServerAssets === true;
export const runtimeRoot = packaged ? packageRoot : resolve(packageRoot, '../..');
const runtimePackage = packaged ? metadata : JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8'));
/** The installed package's version, or the repository's for a source checkout. */
export const packageVersion = /** @type {string} */ (runtimePackage.version);
/** @type {string} */
export const runtimeVersion = runtimePackage.crateServerRuntime ?? runtimePackage.devDependencies.miniflare;
/** @param {string} name */
export const serverAssetPath = name => join(runtimeRoot, packaged ? 'assets' : 'src/cloudflare', name);
export const workerPath = packaged ? serverAssetPath('worker.mjs') : join(runtimeRoot, '.generated/cloudflare/worker.mjs');
// Source runs shared TypeScript modules through Node type stripping; the package ships them transpiled.
/** @param {string} source @param {string} asset */
const sharedModulePath = (source, asset) => packaged ? serverAssetPath(asset) : join(runtimeRoot, source);
export const upgradeRulesPath = sharedModulePath('src/cloudflare/deployment/database-upgrade-rules.ts', 'database-upgrade-rules.mjs');
export const revocationPath = sharedModulePath('src/cloudflare/worker/auth/revocation.ts', 'credential-revocation.mjs');
export const coordinatorPath = sharedModulePath('src/cloudflare/worker/coordinator/coordinator.ts', 'coordinator.mjs');
// The plugin's QR encoder: a repository dependency for source, bundled into the package.
export const qrcodeModule = packaged ? serverAssetPath('qrcode.mjs') : join(runtimeRoot, 'node_modules/qrcode-generator/dist/qrcode.mjs');
