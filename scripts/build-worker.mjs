import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawTextPlugin } from './raw-text-plugin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const generatedDir = resolve(root, '.generated/cloudflare');
const buildVersion = Date.now().toString(36);

function writeGeneratedJson(fileName, payload) {
	mkdirSync(generatedDir, { recursive: true });
	writeFileSync(
		resolve(generatedDir, fileName),
		`${JSON.stringify(payload, null, 2)}\n`,
		'utf-8',
	);
}

async function buildWorkerBundle(pwaClientJs) {
	const result = await build({
		entryPoints: [resolve(root, 'src/cloudflare/worker/index.ts')],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		target: 'esnext',
		write: false,
		minify: false,
		mainFields: ['module', 'main'],
		conditions: ['worker', 'browser', 'import'],
		define: {
			__CRATE_PWA_ASSET_VERSION__: JSON.stringify(buildVersion),
			__CRATE_PWA_CLIENT_JS__: JSON.stringify(pwaClientJs),
		},
		plugins: [rawTextPlugin()],
	});

	const code = result.outputFiles[0].text;
	writeGeneratedJson('worker-script.json', {
		version: buildVersion,
		script: code,
	});
	console.log('Worker bundle written to .generated/cloudflare/worker-script.json');
}

async function buildPwaClientBundle() {
	const result = await build({
		entryPoints: [resolve(root, 'src/cloudflare/worker/pwa-client.tsx')],
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2020',
		write: false,
		minify: true,
		define: {
			'process.env.NODE_ENV': JSON.stringify('production'),
			__CRATE_PWA_ASSET_VERSION__: JSON.stringify(buildVersion),
		},
		alias: {
			'react': 'preact/compat',
			'react-dom': 'preact/compat',
			'react/jsx-runtime': 'preact/jsx-runtime',
		},
		mainFields: ['browser', 'module', 'main'],
		conditions: ['browser', 'import'],
	});

	const code = result.outputFiles[0].text;
	writeGeneratedJson('pwa-client.json', {
		version: buildVersion,
		script: code,
	});
	console.log('PWA client bundle written to .generated/cloudflare/pwa-client.json');
	return code;
}

const pwaClientJs = await buildPwaClientBundle();
await buildWorkerBundle(pwaClientJs);
