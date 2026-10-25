import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { compile } from 'sass';

// The id carries the file path, so ids cached by an earlier run still resolve.
const prefix = '\0raw-css:';

export function rawCssPlugin() {
	return {
		name: 'raw-css',
		enforce: 'pre',
		resolveId(source, importer) {
			const suffix = source.endsWith('?raw-css')
				? '?raw-css'
				: source.endsWith('?raw-text')
					? '?raw-text'
					: null;
			if (!suffix) {
				return null;
			}

			const requestPath = source.slice(0, -suffix.length);
			const filePath = isAbsolute(requestPath)
				? requestPath
				: resolve(importer ? dirname(importer) : process.cwd(), requestPath);
			return `${prefix}${filePath}`;
		},
		load(id) {
			if (!id.startsWith(prefix)) {
				return null;
			}
			const filePath = id.slice(prefix.length);

			const contents = filePath.endsWith('.scss')
				? compile(filePath).css
				: readFileSync(filePath, 'utf-8');

			return `export default ${JSON.stringify(contents)};`;
		},
	};
}
