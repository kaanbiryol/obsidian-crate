import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawTextPlugin } from './raw-text-plugin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const generatedDir = resolve(root, '.generated/cloudflare');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const serverVersion = typeof packageJson.version === 'string' ? packageJson.version : 'dev';
const PWA_VERSION_PLACEHOLDER = 'crate-pwa-version-placeholder';

function sha256(content) {
	return createHash('sha256').update(content).digest('hex');
}

function writeGeneratedJson(fileName, payload) {
	mkdirSync(generatedDir, { recursive: true });
	writeFileSync(
		resolve(generatedDir, fileName),
		`${JSON.stringify(payload, null, 2)}\n`,
		'utf-8',
	);
}

async function buildWorkerBundle(pwaClientJs, pwaAssetVersion) {
	const result = await build({
		entryPoints: [resolve(root, 'src/cloudflare/worker/index.ts')],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		target: 'esnext',
		write: false,
		minify: true,
		legalComments: 'none',
		mainFields: ['module', 'main'],
		conditions: ['worker', 'browser', 'import'],
		loader: { '.png': 'binary' },
		define: {
			__CRATE_SERVER_VERSION__: JSON.stringify(serverVersion),
			__CRATE_PWA_ASSET_VERSION__: JSON.stringify(pwaAssetVersion),
			__CRATE_PWA_CLIENT_JS__: JSON.stringify(pwaClientJs),
		},
		plugins: [rawTextPlugin()],
	});

	const code = result.outputFiles[0].text;
	mkdirSync(generatedDir, { recursive: true });
	writeFileSync(resolve(generatedDir, 'worker.mjs'), code, 'utf-8');
	console.log('Deployable Worker bundle written to .generated/cloudflare/worker.mjs');
}

async function bundlePwaClient(assetVersion) {
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
			__CRATE_PWA_ASSET_VERSION__: JSON.stringify(assetVersion),
		},
		alias: {
			'react': 'preact/compat',
			'react-dom': 'preact/compat',
			'react/jsx-runtime': 'preact/jsx-runtime',
		},
		mainFields: ['browser', 'module', 'main'],
		conditions: ['browser', 'import'],
	});
	return result.outputFiles[0].text;
}

async function buildPwaClientBundle() {
	const versionTemplate = await bundlePwaClient(PWA_VERSION_PLACEHOLDER);
	const version = sha256(versionTemplate).slice(0, 16);
	const code = await bundlePwaClient(version);
	writeGeneratedJson('pwa-client.json', {
		version,
		script: code,
	});
	console.log('PWA client bundle written to .generated/cloudflare/pwa-client.json');
	return { code, version };
}

const pwaClient = await buildPwaClientBundle();
await buildWorkerBundle(pwaClient.code, pwaClient.version);
