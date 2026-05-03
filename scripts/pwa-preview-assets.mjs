import { spawnSync } from 'node:child_process';
import { createJiti } from 'jiti';

export async function buildPwaPreviewAssets() {
	const buildResult = spawnSync(process.execPath, ['scripts/build-worker.mjs'], {
		cwd: process.cwd(),
		stdio: 'inherit',
	});

	if (buildResult.status !== 0) {
		const error = new Error(`PWA worker build failed with status ${buildResult.status ?? 1}`);
		error.status = buildResult.status ?? 1;
		throw error;
	}

	const jiti = createJiti(import.meta.url, { interopDefault: true });
	return jiti.import('../src/cloudflare/worker/pwa.ts');
}
