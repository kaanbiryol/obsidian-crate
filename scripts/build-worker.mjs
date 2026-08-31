import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawTextPlugin } from './raw-text-plugin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const generatedDir = resolve(root, '.generated/cloudflare');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const serverVersion = typeof packageJson.version === 'string' ? packageJson.version : 'dev';
const PWA_VERSION_PLACEHOLDER = 'crate-pwa-version-placeholder';

function listFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? listFiles(path) : [path];
	});
}

function createPwaAssetVersion(clientAssets) {
	const hash = createHash('sha256');
	for (const [name, source] of Object.entries(clientAssets).sort(([left], [right]) => left.localeCompare(right))) {
		hash.update(name);
		hash.update(source);
	}
	const pwaSourceRoot = resolve(root, 'src/cloudflare/worker/pwa');

	for (const path of listFiles(pwaSourceRoot).sort()) {
		hash.update(relative(root, path));
		hash.update(readFileSync(path));
	}

	return hash.digest('hex').slice(0, 16);
}

function writeGeneratedJson(fileName, payload) {
	mkdirSync(generatedDir, { recursive: true });
	writeFileSync(
		resolve(generatedDir, fileName),
		`${JSON.stringify(payload, null, 2)}\n`,
		'utf-8',
	);
}

async function buildWorkerBundle(pwaClientAssets, pwaAssetVersion) {
	const result = await build({
		entryPoints: [resolve(root, 'src/cloudflare/worker/index.ts')],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		target: 'esnext',
		write: false,
		minify: true,
		legalComments: 'eof',
		mainFields: ['module', 'main'],
		conditions: ['worker', 'browser', 'import'],
		loader: { '.png': 'binary' },
		define: {
			__CRATE_SERVER_VERSION__: JSON.stringify(serverVersion),
			__CRATE_PWA_ASSET_VERSION__: JSON.stringify(pwaAssetVersion),
			__CRATE_PWA_CLIENT_ASSETS__: JSON.stringify(pwaClientAssets),
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
		entryPoints: [resolve(root, 'src/pwa/main.tsx')],
		bundle: true,
		splitting: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2020',
		write: false,
		outdir: 'pwa-client',
		entryNames: 'app',
		chunkNames: 'chunk-[hash]',
		publicPath: '/notifications/assets',
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
		legalComments: 'eof',
	});
	return Object.fromEntries(result.outputFiles.map(output => [basename(output.path), output.text]));
}

async function buildPwaClientBundle() {
	const versionTemplate = await bundlePwaClient(PWA_VERSION_PLACEHOLDER);
	const version = createPwaAssetVersion(versionTemplate);
	const assets = await bundlePwaClient(version);
	const script = assets['app.js'];
	if (!script) throw new Error('PWA client build did not emit app.js');
	writeGeneratedJson('pwa-client.json', {
		version,
		script,
		assets,
	});
	console.log('PWA client bundle written to .generated/cloudflare/pwa-client.json');
	return { assets, version };
}

const pwaClient = await buildPwaClientBundle();
await buildWorkerBundle(pwaClient.assets, pwaClient.version);
