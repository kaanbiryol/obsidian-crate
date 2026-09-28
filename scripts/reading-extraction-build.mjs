import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';

/** Adapt Defuddle's published browser bundle to an inert DOM in either host.
 * Its Markdown converter expects window.DOMParser. Keep all upstream conversion
 * rules intact, and strip diagnostics that could log fetched article content.
 */
async function extractionSource(source) {
	return `import { DOMParser } from 'linkedom'; const window = { DOMParser };\n`
		+ (await transform(source, { drop: ['console'], legalComments: 'eof' })).code;
}

const defuddleBundle = /defuddle[\\/]dist[\\/]index\.full\.js$/;

export function readingExtractionPlugin() {
	return {
		name: 'reading-extraction-runtime',
		setup(build) {
			build.onLoad({ filter: defuddleBundle }, async ({ path }) => ({
				contents: await extractionSource(await readFile(path, 'utf8')),
				loader: 'js',
			}));
		},
	};
}

export function readingExtractionVitePlugin() {
	return {
		name: 'reading-extraction-runtime',
		enforce: 'pre',
		async transform(source, id) {
			if (defuddleBundle.test(id)) return { code: await extractionSource(source), map: null };
		},
	};
}
