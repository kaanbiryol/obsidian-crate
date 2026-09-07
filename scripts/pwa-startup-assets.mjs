import { basename } from 'node:path';

/** Follow only static imports; lazy editor pickers and settings stay deferred. */
export function getPwaStartupAssets(metafile) {
	return collectAppAssets(metafile, false);
}

/** Keep every reachable lazy asset, excluding unused build-entry facades. */
export function getPwaClientAssets(metafile) {
	return collectAppAssets(metafile, true);
}

function collectAppAssets(metafile, includeDynamicImports) {
	const entry = Object.keys(metafile.outputs).find(path => basename(path) === 'app.js');
	if (!entry) throw new Error('PWA client build did not emit app.js');
	const visited = new Set();
	function visit(path) {
		if (visited.has(path)) return;
		const output = metafile.outputs[path];
		if (!output) throw new Error(`Missing PWA startup output: ${path}`);
		visited.add(path);
		for (const dependency of output.imports) {
			if (!dependency.external && (dependency.kind === 'import-statement'
				|| includeDynamicImports && dependency.kind === 'dynamic-import')) visit(dependency.path);
		}
	}
	visit(entry);
	return [...visited].map(path => basename(path));
}
