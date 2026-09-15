import { build } from 'esbuild';
import { rawTextPlugin } from './raw-text-plugin.mjs';
import { existsSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/** Follow transitive runtime and build imports, including shared PWA UI code. */
export async function collectServerInputs(root, metafiles, rawInputs) {
	const deployment = await build({
		absWorkingDir: root,
		entryPoints: ['src/cloudflare/provisioner.ts', 'src/cloudflare/deployment-recovery.ts', 'src/cloudflare/server-delete.ts',
			'scripts/build-worker.mjs', 'scripts/cloudflare-artifacts-vite-plugin.mjs'],
		bundle: true, packages: 'external', platform: 'node', format: 'esm',
		metafile: true, write: false, outdir: '.generated/server-input-analysis',
		plugins: [rawTextPlugin(path => rawInputs.add(path))],
	});
	const inputs = new Set([...rawInputs].map(path => relative(root, path)));
	for (const metafile of [...metafiles, deployment.metafile]) {
		for (const path of Object.keys(metafile.inputs)) {
			if (path.startsWith('raw-text:') || path.startsWith('<')) continue; // Raw files are collected by the loader.
			if (!path.startsWith('node_modules/')) inputs.add(path);
		}
	}
	// These are read dynamically or affect compilation without appearing in esbuild's graph.
	for (const path of ['src/cloudflare/schema.sql', 'src/cloudflare/server-release.json',
		'tsconfig.json', 'src/cloudflare/worker/tsconfig.json', '.nvmrc']) inputs.add(path);
	const migrations = resolve(root, 'src/cloudflare/migrations');
	for (const file of existsSync(migrations) ? readdirSync(migrations, { withFileTypes: true }) : []) {
		if (file.isFile() && file.name.endsWith('.sql')) inputs.add(`src/cloudflare/migrations/${file.name}`);
	}
	return [...inputs].sort();
}
