import { build } from 'esbuild';
import { basename, resolve } from 'node:path';
import { getPwaStartupAssets } from './pwa-startup-assets.mjs';

export async function bundlePwaClient(assetVersion, root) {
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
