import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { compile } from 'sass';

function listFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? listFiles(path) : [path];
	});
}

export function createPwaAssetVersion(clientAssets, root) {
	const hash = createHash('sha256');
	for (const [name, source] of Object.entries(clientAssets).sort(([left], [right]) => left.localeCompare(right))) {
		hash.update(name);
		hash.update(source);
	}
	for (const path of listFiles(resolve(root, 'src/cloudflare/worker/pwa')).sort()) {
		hash.update(relative(root, path));
		hash.update(readFileSync(path));
	}

	// Shared Sass is outside the Worker source tree and is not in the JS bundle.
	// Hash the compiled stylesheet so every transitive UI import updates the cache.
	hash.update(compile(resolve(root, 'src/pwa/styles/reminders-view.scss')).css);
	return hash.digest('hex').slice(0, 16);
}
