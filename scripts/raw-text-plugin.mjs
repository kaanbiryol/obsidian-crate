import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'sass';
import { transformSync } from 'esbuild';

export function rawTextPlugin(onRead = () => {}) {
	return {
		name: 'raw-text',
		setup(build) {
			build.onResolve({ filter: /\?raw(?:-(?:css|text))?$/ }, (args) => ({
				path: resolve(args.resolveDir, args.path.replace(/\?raw(?:-(?:css|text))?$/, '')),
				namespace: 'raw-text',
			}));

			build.onLoad({ filter: /.*/, namespace: 'raw-text' }, (args) => {
				onRead(args.path);
				if (!args.path.endsWith('.scss')) {
					const source = readFileSync(args.path, 'utf-8');
					// CSS is embedded as a JS string; the JS minifier cannot compact it.
					const contents = args.path.endsWith('.css')
						? transformSync(source, { loader: 'css', minify: true, legalComments: 'eof' }).code : source;
					return { contents, loader: 'text' };
				}
				const result = compile(args.path, { style: 'compressed' });
				for (const url of result.loadedUrls) if (url.protocol === 'file:') onRead(fileURLToPath(url));
				return { contents: result.css, loader: 'text' };
			});
		},
	};
}
