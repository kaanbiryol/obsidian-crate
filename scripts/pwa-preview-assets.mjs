import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { rawTextPlugin } from './raw-text-plugin.mjs';

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

	const pwaBundle = await build({
		entryPoints: [resolve(process.cwd(), 'src/cloudflare/worker/pwa.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'es2020',
		write: false,
		plugins: [rawTextPlugin()],
	});
	const code = pwaBundle.outputFiles[0].text;
	const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
	return import(url);
}
