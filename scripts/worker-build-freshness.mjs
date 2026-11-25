import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Why the Worker build in `.generated/cloudflare` cannot stand for the current source, or null
 * when it can: missing output, a development build, or an input edited after the build.
 * @param {string} rootDir
 * @returns {string | null}
 */
export function staleWorkerBuild(rootDir) {
	const generated = resolve(rootDir, '.generated/cloudflare');
	let identity, inputs, builtAt;
	try {
		identity = JSON.parse(readFileSync(resolve(generated, 'build-identity.json'), 'utf8'));
		inputs = JSON.parse(readFileSync(resolve(generated, 'server-inputs.json'), 'utf8'));
		builtAt = Math.min(...['worker.mjs', 'worker-self-hosted.mjs', 'pwa-client.json', 'build-identity.json'].map(name => statSync(resolve(generated, name)).mtimeMs));
	} catch (error) {
		return `no completed Worker build (${error instanceof Error ? error.message : String(error)})`;
	}
	if (identity.development !== null) return 'a development Worker build';
	/** @type {string[]} */
	const stale = inputs.filter(/** @param {string} path */ path => !existsSync(resolve(rootDir, path)) || statSync(resolve(rootDir, path)).mtimeMs > builtAt);
	return stale.length ? `Worker inputs changed after the build:\n${stale.map(path => `  ${path}`).join('\n')}` : null;
}
