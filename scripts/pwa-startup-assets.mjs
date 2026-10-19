import { basename } from 'node:path';

/** Follow only static imports; lazy editor pickers and settings stay deferred. */
export function getPwaStartupAssets(metafile) {
	return collectAppAssets(metafile, false);
}

/** Keep every reachable lazy asset, excluding unused build-entry facades. */
export function getPwaClientAssets(metafile) {
	return collectAppAssets(metafile, true);
}

// Article and transcript extraction only run on a page the browser just
// downloaded, so caching them ahead of time never helps offline use. The
// service worker caches them on use instead.
const ON_DEMAND_ENTRY_POINTS = new Set([
	'src/reading/extraction/document.ts',
	'src/reading/extraction/youtube-transcript.ts',
]);

/** Lazy assets reachable only through an on-demand entry; excluded from precache. */
export function getPwaOnDemandAssets(metafile) {
	const precached = new Set(collectAppAssets(metafile, true, output => ON_DEMAND_ENTRY_POINTS.has(output.entryPoint)));
	return getPwaClientAssets(metafile).filter(name => !precached.has(name));
}

function collectAppAssets(metafile, includeDynamicImports, isOnDemand = () => false) {
	const entry = Object.keys(metafile.outputs).find(path => basename(path) === 'app.js');
	if (!entry) throw new Error('PWA client build did not emit app.js');
	const visited = new Set();
	function visit(path) {
		if (visited.has(path)) return;
		const output = metafile.outputs[path];
		if (!output) throw new Error(`Missing PWA startup output: ${path}`);
		if (isOnDemand(output)) return;
		visited.add(path);
		for (const dependency of output.imports) {
			if (!dependency.external && (dependency.kind === 'import-statement'
				|| includeDynamicImports && dependency.kind === 'dynamic-import')) visit(dependency.path);
		}
	}
	visit(entry);
	return [...visited].map(path => basename(path));
}
