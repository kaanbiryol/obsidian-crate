import { build } from 'esbuild';
import { basename, resolve } from 'node:path';
import { getPwaClientAssets, getPwaStartupAssets } from './pwa-startup-assets.mjs';

export async function bundlePwaClient(assetVersion, root) {
	const result = await build({
		absWorkingDir: root,
		// A second build entry gives the editor a stable chunk boundary. App still
		// imports it statically, so first-tap keyboard activation stays synchronous.
		entryPoints: {
			app: resolve(root, 'src/pwa/main.tsx'),
			'reminder-editor': resolve(root, 'src/pwa/components/ReminderSheet.tsx'),
		},
		bundle: true,
		splitting: true,
		metafile: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2020',
		write: false,
		outdir: 'pwa-client',
		entryNames: '[name]',
		chunkNames: 'chunk-[hash]',
		publicPath: '/notifications/assets',
		minify: true,
		define: {
			'process.env.NODE_ENV': JSON.stringify('production'),
			__CRATE_PWA_ASSET_VERSION__: JSON.stringify(assetVersion),
		},
		mainFields: ['browser', 'module', 'main'],
		conditions: ['browser', 'import'],
		legalComments: 'eof',
	});
	const reachableAssets = new Set(getPwaClientAssets(result.metafile));
	return {
		metafile: result.metafile,
		assets: Object.fromEntries(result.outputFiles
			.filter(output => reachableAssets.has(basename(output.path)))
			.map(output => [basename(output.path), output.text])),
		startupAssets: getPwaStartupAssets(result.metafile),
	};
}
