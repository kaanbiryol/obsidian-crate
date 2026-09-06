import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawTextPlugin } from './raw-text-plugin.mjs';
import { createPwaAssetVersion } from './pwa-asset-version.mjs';
import { getPwaStartupAssets } from './pwa-startup-assets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const generatedDir = resolve(root, '.generated/cloudflare');
// This identifies the Cloudflare service, not the Obsidian plugin release.
// Keeping it stable prevents an otherwise unrelated plugin version bump from
// changing the Worker bundle and prompting users to redeploy their server.
const serverVersion = 'crate';
const PWA_VERSION_PLACEHOLDER = 'crate-pwa-version-placeholder';

function writeGeneratedJson(fileName, payload) {
	mkdirSync(generatedDir, { recursive: true });
	writeFileSync(
		resolve(generatedDir, fileName),
		`${JSON.stringify(payload, null, 2)}\n`,
		'utf-8',
	);
}

async function buildWorkerBundle(pwaClientAssets, pwaAssetVersion, startupAssets) {
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
			__CRATE_PWA_STARTUP_ASSETS__: JSON.stringify(startupAssets),
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
		metafile: true,
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
	return {
		assets: Object.fromEntries(result.outputFiles.map(output => [basename(output.path), output.text])),
		startupAssets: getPwaStartupAssets(result.metafile),
	};
}

async function buildPwaClientBundle() {
	const versionTemplate = await bundlePwaClient(PWA_VERSION_PLACEHOLDER);
	const version = createPwaAssetVersion(versionTemplate.assets, root);
	const { assets, startupAssets } = await bundlePwaClient(version);
	const script = assets['app.js'];
	if (!script) throw new Error('PWA client build did not emit app.js');
	writeGeneratedJson('pwa-client.json', {
		version,
		script,
		assets,
		startupAssets,
	});
	console.log('PWA client bundle written to .generated/cloudflare/pwa-client.json');
	return { assets, version, startupAssets };
}

const pwaClient = await buildPwaClientBundle();
await buildWorkerBundle(pwaClient.assets, pwaClient.version, pwaClient.startupAssets);
