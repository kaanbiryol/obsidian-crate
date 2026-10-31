import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = 'src';
const BASELINE_PATH = 'scripts/style-token-baseline.json';
const WRITE_COMMAND = 'node scripts/check-style-tokens.mjs --write';

/** Blanks comments while keeping line breaks, so reported lines match the source. */
const withoutComments = source => source
	.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
	.replace(/(^|[^:])\/\/[^\n]*/gm, (comment, before) => before + ' '.repeat(comment.length - before.length));

/** Removes var() groups, so a token's fallback is not reported as a literal. */
function withoutVars(value) {
	let previous;
	do {
		previous = value;
		value = value.replace(/var\([^()]*\)/g, '');
	} while (value !== previous);
	return value;
}

const ABSOLUTE_SIZE = /\d(px|pt|rem)\b/i;
const NUMERIC_WEIGHT = /(^|\s)\d{3}(\s|$)/;
const LITERAL = {
	'font-size': value => ABSOLUTE_SIZE.test(value),
	'font-weight': value => NUMERIC_WEIGHT.test(value),
	font: value => ABSOLUTE_SIZE.test(value) || NUMERIC_WEIGHT.test(value),
};

/**
 * Font declarations that bypass the `--crate-font-*` roles: absolute sizes and
 * numeric weights outside var(). Relative sizes such as `1.35em` scale with
 * their content and stay allowed, as do custom properties that define roles.
 */
export function findLiteralFontDeclarations(source) {
	const text = withoutComments(source);
	const findings = [];
	for (const match of text.matchAll(/(?<![\w$-])(font-size|font-weight|font)\s*:\s*([^;{}]+)/g)) {
		const [, property, value] = match;
		if (!LITERAL[property](withoutVars(value).trim())) continue;
		findings.push({ line: text.slice(0, match.index).split('\n').length, declaration: `${property}: ${value.trim()}` });
	}
	return findings;
}

async function scan() {
	const files = (await readdir(ROOT, { recursive: true }))
		.filter(file => /\.s?css$/.test(file))
		.map(file => join(ROOT, file).replaceAll('\\', '/'))
		.sort();
	const findings = new Map();
	for (const file of files) {
		const found = findLiteralFontDeclarations(await readFile(file, 'utf8'));
		if (found.length) findings.set(file, found);
	}
	return findings;
}

if (import.meta.main) {
	const findings = await scan();
	const counts = Object.fromEntries([...findings].map(([file, found]) => [file, found.length]));
	if (process.argv.includes('--write')) {
		await writeFile(BASELINE_PATH, `${JSON.stringify(counts, null, '\t')}\n`);
		console.log(`Recorded ${Object.values(counts).reduce((sum, count) => sum + count, 0)} literal font declarations in ${BASELINE_PATH}.`);
	} else {
		const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
		const files = [...new Set([...Object.keys(baseline), ...findings.keys()])].sort();
		const added = files.filter(file => (counts[file] ?? 0) > (baseline[file] ?? 0));
		const removed = files.filter(file => (counts[file] ?? 0) < (baseline[file] ?? 0));
		if (added.length) {
			console.error('Use the --crate-font-* roles from src/ui/shared/styles/_tokens.scss instead of literal font sizes and weights:');
			for (const file of added) {
				for (const { line, declaration } of findings.get(file)) console.error(`- ${file}:${line} ${declaration}`);
			}
			console.error(`If a literal must stay, record it with \`${WRITE_COMMAND}\`.`);
			process.exitCode = 1;
		}
		if (removed.length) {
			console.error(`Literal font declarations were removed from ${removed.join(', ')}. Run \`${WRITE_COMMAND}\` to lower the baseline.`);
			process.exitCode = 1;
		}
		if (!process.exitCode) console.log('Font sizes and weights use the --crate-font-* roles or a recorded literal.');
	}
}
