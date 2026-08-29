import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { compile } from 'sass';

export function rawCssPlugin() {
	const cssFiles = new Map();

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
			const moduleId = `\0raw-css:${cssFiles.size}`;
			cssFiles.set(moduleId, filePath);
			return moduleId;
		},
		load(id) {
			const filePath = cssFiles.get(id);
			if (!filePath) {
				return null;
			}

			const contents = filePath.endsWith('.scss')
				? compile(filePath).css
				: readFileSync(filePath, 'utf-8');

			return `export default ${JSON.stringify(contents)};`;
		},
	};
}
