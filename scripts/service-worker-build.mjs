import { build } from 'esbuild';
import { resolve } from 'node:path';

/** Version-neutral runtime: hash these bytes before injecting final shell URLs. */
export async function bundleServiceWorkerRuntime(root) {
	const result = await build({
		absWorkingDir: root,
		entryPoints: [resolve(root, 'src/pwa/service-worker/runtime.ts')],
		tsconfig: resolve(root, 'src/pwa/service-worker/tsconfig.json'),
		bundle: true,
		format: 'iife',
		globalName: 'crateServiceWorker',
		platform: 'browser',
		target: 'es2022',
		write: false,
		metafile: true,
		minify: true,
		legalComments: 'eof',
	});
	return { script: result.outputFiles[0].text, metafile: result.metafile };
}
