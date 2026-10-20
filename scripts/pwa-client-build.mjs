import { build } from 'esbuild';
import { basename, resolve } from 'node:path';
import { getPwaClientAssets, getPwaOnDemandAssets, getPwaStartupAssets } from './pwa-startup-assets.mjs';
import { readingExtractionPlugin } from './reading-extraction-build.mjs';

// The asset version is read from the shell at runtime, so client output is
// independent of it and unchanged chunks keep their hashes across deploys.
export async function bundlePwaClient(root) {
	const result = await build({
		absWorkingDir: root,
		// A second build entry gives the editor a stable chunk boundary. App still
		// imports it statically, so first-tap keyboard activation stays synchronous.
		entryPoints: {
			app: resolve(root, 'src/pwa/main.tsx'),
			'reminder-editor': resolve(root, 'src/pwa/reminders/editor/ReminderSheet.tsx'),
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
		},
		mainFields: ['browser', 'module', 'main'],
		conditions: ['browser', 'import', 'production'],
		legalComments: 'eof',
		plugins: [readingExtractionPlugin()],
	});
	const reachableAssets = new Set(getPwaClientAssets(result.metafile));
	return {
		metafile: result.metafile,
		assets: Object.fromEntries(result.outputFiles
			.filter(output => reachableAssets.has(basename(output.path)))
			.map(output => [basename(output.path), output.text])),
		startupAssets: getPwaStartupAssets(result.metafile),
		onDemandAssets: getPwaOnDemandAssets(result.metafile),
	};
}
