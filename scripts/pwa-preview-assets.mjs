import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rawTextPlugin } from './raw-text-plugin.mjs';

async function readGeneratedPwaClient() {
	const generatedPath = resolve(process.cwd(), '.generated/cloudflare/pwa-client.json');
	const payload = JSON.parse(await readFile(generatedPath, 'utf-8'));
	if (
		!payload
		|| typeof payload !== 'object'
		|| typeof payload.version !== 'string'
		|| typeof payload.script !== 'string'
		|| payload.script.length === 0
	) {
		throw new Error(`Invalid generated PWA client bundle: ${generatedPath}`);
	}
	return payload;
}

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

	const pwaClient = await readGeneratedPwaClient();
	const pwaBundle = await build({
		entryPoints: [resolve(process.cwd(), 'src/cloudflare/worker/pwa.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'es2020',
		write: false,
		define: {
			__CRATE_PWA_ASSET_VERSION__: JSON.stringify(pwaClient.version),
			__CRATE_PWA_CLIENT_JS__: JSON.stringify(pwaClient.script),
		},
		loader: { '.png': 'binary' },
		plugins: [rawTextPlugin()],
	});
	const code = pwaBundle.outputFiles[0].text;
	const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
	return import(url);
}
