import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { test } from 'node:test';

// Browser tests and tooling bundle source modules by path, which TypeScript never
// checks. Fail fast when a source move leaves one of these references behind.
const root = join(import.meta.dirname, '..');
const files = execFileSync('git', ['ls-files', 'scripts/*.mjs', 'tests/browser/**/*.mjs'], { cwd: root, encoding: 'utf8' })
	// Tooling unit tests build fixture repositories with placeholder paths.
	.split('\n').filter(file => file && !(file.startsWith('scripts/') && file.endsWith('.test.mjs')));
const extensions = ['', '.ts', '.tsx', '.mjs', '.js', '.scss', '.css', '/index.ts'];
const exists = path => extensions.some(extension => existsSync(join(root, path + extension)))
	|| existsSync(join(root, dirname(path), `_${path.split('/').at(-1)}.scss`));

test('source paths referenced by browser tests and scripts exist', () => {
	const missing = [];
	for (const file of files) {
		const text = readFileSync(join(root, file), 'utf8');
		for (const [, path] of text.matchAll(/['"`](?:\.\/)?((?:src|tests)\/[\w@/.-]+?)['"`;?]/g)) {
			if (!exists(path)) missing.push(`${file}: ${path}`);
		}
		// esbuild stdin modules resolve src/ and tests/ paths from the repository root, checked above.
		for (const [, specifier] of text.matchAll(/^import\s[^;]*?\bfrom\s+['"](\.{1,2}\/(?!src\/|tests\/)[^'"]+)['"]/gm)) {
			if (!exists(normalize(join(dirname(file), specifier.split('?')[0])))) missing.push(`${file}: ${specifier}`);
		}
	}
	assert.deepEqual(missing, []);
});

test('files named by package scripts exist', () => {
	const scripts = Object.values(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts).join(' ');
	const missing = [...new Set(scripts.match(/(?:src|tests|scripts)\/[\w@./-]+\.(?:mjs|ts|tsx|json|py)/g))]
		.filter(path => !existsSync(join(root, path)));
	assert.deepEqual(missing, []);
});
