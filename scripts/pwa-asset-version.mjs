import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'sass';

function listFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		// Finder/Explorer metadata is not an app asset or a server build input.
		if (entry.name === '.DS_Store' || entry.name.startsWith('._')
			|| entry.name === 'Thumbs.db' || entry.name === 'desktop.ini') return [];
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? listFiles(path) : [path];
	});
}

export function createPwaAssetVersion(clientAssets, root, onRead = () => {}) {
	const hash = createHash('sha256');
	for (const [name, source] of Object.entries(clientAssets).sort(([left], [right]) => left.localeCompare(right))) {
		hash.update(name);
		hash.update(source);
	}
	for (const path of listFiles(resolve(root, 'src/cloudflare/worker/pwa')).sort()) {
		onRead(path);
		hash.update(relative(root, path));
		hash.update(readFileSync(path));
	}

	// Sass imported as Worker text is outside both the Worker source tree and
	// the client bundle. Hash every compiled entry, including mode transitions.
	const stylesEntry = resolve(root, 'src/cloudflare/worker/pwa/styles.ts');
	const imports = readFileSync(stylesEntry, 'utf-8').matchAll(/from\s+['"]([^'"]+\.scss)\?raw-css['"]/g);
	for (const [, source] of imports) {
		const path = resolve(dirname(stylesEntry), source);
		const result = compile(path);
		hash.update(relative(root, path));
		hash.update(result.css);
		for (const url of result.loadedUrls) if (url.protocol === 'file:') onRead(fileURLToPath(url));
	}
	return hash.digest('hex').slice(0, 16);
}
