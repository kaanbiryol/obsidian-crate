import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'sass';

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
				if (!args.path.endsWith('.scss')) return { contents: readFileSync(args.path, 'utf-8'), loader: 'text' };
				const result = compile(args.path);
				for (const url of result.loadedUrls) if (url.protocol === 'file:') onRead(fileURLToPath(url));
				return { contents: result.css, loader: 'text' };
			});
		},
	};
}
