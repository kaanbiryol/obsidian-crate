import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function rawTextPlugin() {
	return {
		name: 'raw-text',
		setup(build) {
			build.onResolve({ filter: /\?raw-css$/ }, (args) => ({
				path: resolve(args.resolveDir, args.path.slice(0, -'?raw-css'.length)),
				namespace: 'raw-text',
			}));

			build.onLoad({ filter: /.*/, namespace: 'raw-text' }, (args) => ({
				contents: readFileSync(args.path, 'utf-8'),
				loader: 'text',
			}));
		},
	};
}
