import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';

/** Adapt Defuddle's published browser bundle to workerd without global DOM state.
 * Its Markdown converter expects window.DOMParser. Keep all upstream conversion
 * rules intact, and strip diagnostics that could log fetched article content.
 */
export function readingExtractionPlugin() {
	return {
		name: 'reading-extraction-runtime',
		setup(build) {
			build.onLoad({ filter: /defuddle[\\/]dist[\\/]index\.full\.js$/ }, async ({ path }) => ({
				contents: `import { DOMParser } from 'linkedom'; const window = { DOMParser };\n`
					+ (await transform(await readFile(path, 'utf8'), { drop: ['console'], legalComments: 'eof' })).code,
				loader: 'js',
			}));
		},
	};
}
