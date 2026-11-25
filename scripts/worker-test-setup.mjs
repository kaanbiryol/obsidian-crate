import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { staleWorkerBuild } from './worker-build-freshness.mjs';

const root = resolve(import.meta.dirname, '..');

/** Vitest global setup for the Worker runtime suites. Their Durable Objects run the built
 * Worker in `.generated/cloudflare`, not the source, so a stale build would test old code
 * without a sign. It is built again first, unless a release gate said it is prebuilt. */
export default function setup() {
	const stale = staleWorkerBuild(root);
	if (!stale) return;
	if (process.env.CRATE_WORKER_PREBUILT === '1') {
		// Vitest can lose a global setup error while mapping its stack, so it is printed first.
		const message = `CRATE_WORKER_PREBUILT=1 found ${stale}; run npm run build:worker.`;
		console.error(message);
		throw new Error(message);
	}
	console.log(`Building the Worker before its tests: found ${stale.split('\n')[0]}`);
	const result = spawnSync(process.execPath, ['scripts/build-worker.mjs'], { cwd: root, stdio: 'inherit' });
	if (result.status !== 0) throw new Error('npm run build:worker failed; the Worker tests need a current build.');
}
