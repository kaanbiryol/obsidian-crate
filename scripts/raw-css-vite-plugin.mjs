import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

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

			return `export default ${JSON.stringify(readFileSync(filePath, 'utf-8'))};`;
		},
	};
}
