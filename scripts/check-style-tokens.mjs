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
const DURATION = /(?<![\w.-])(\d*\.?\d+)m?s\b/g;
const PIXELS = /(?<![\w.-])-?(\d*\.?\d+)px\b/g;
// Small spacing stays on the shared scale; 1px and 2px hairline nudges are exempt.
const SPACING_SCALE = new Set([0, 1, 2, 4, 6, 8, 12, 16, 20]);

/**
 * Each rule names the properties it checks and what counts as a literal once
 * var() groups are removed. Custom properties are never checked: they define
 * the roles. Sass constants such as `tokens.$layer-sheet` contain no literal.
 */
const RULES = [
	{
		name: 'font',
		property: /^(font|font-size|font-weight)$/,
		literal: value => ABSOLUTE_SIZE.test(value) || NUMERIC_WEIGHT.test(value),
		hint: 'Use the --crate-font-* roles instead of literal font sizes and weights.',
	},
	{
		name: 'layer',
		property: /^z-index$/,
		literal: value => /^-?\d+$/.test(value) && Math.abs(Number(value)) >= 10,
		hint: 'Use a tokens.$layer-* constant for layers that compete across components; local stacking from -9 to 9 stays inline.',
	},
	{
		name: 'motion',
		property: /^(transition|animation)(-duration|-timing-function)?$/,
		literal: value => value.includes('cubic-bezier(') || [...value.matchAll(DURATION)].some(([, amount]) => Number(amount) !== 0),
		hint: 'Use the --pwa-motion-* or --crate-motion-* roles, or tokens.$easing-*, instead of literal durations and curves.',
	},
	{
		name: 'radius',
		property: /^border(-[a-z]+)*-radius$/,
		literal: value => [...value.matchAll(PIXELS)].some(([, amount]) => Number(amount) !== 0),
		hint: 'Use the --crate-radius-* roles or tokens.$radius-pill instead of literal radii.',
	},
	{
		name: 'spacing',
		property: /^((padding|margin)(-(top|right|bottom|left|block|inline)(-(start|end))?)?|(row-|column-)?gap)$/,
		literal: value => [...value.matchAll(PIXELS)].some(([, amount]) => Number(amount) < 24 && !SPACING_SCALE.has(Number(amount))),
		hint: 'Use the 4, 6, 8, 12, 16, 20 and 24px spacing scale (--crate-space-*) for padding, margins and gaps.',
	},
];

/** Declarations that bypass the shared roles, with the rule each one breaks. */
export function findLiteralDeclarations(source) {
	const text = withoutComments(source);
	const findings = [];
	for (const match of text.matchAll(/(?<![\w$-])([a-z][a-z-]*)\s*:\s*([^;{}]+)/g)) {
		const [, property, value] = match;
		const rule = RULES.find(candidate => candidate.property.test(property));
		if (!rule?.literal(withoutVars(value).trim())) continue;
		findings.push({ rule: rule.name, line: text.slice(0, match.index).split('\n').length, declaration: `${property}: ${value.trim()}` });
	}
	return findings;
}

async function scan() {
	const files = (await readdir(ROOT, { recursive: true }))
		.filter(file => /\.s?css$/.test(file))
		.map(file => join(ROOT, file).replaceAll('\\', '/'))
		.sort();
	const findings = [];
	for (const file of files) {
		for (const finding of findLiteralDeclarations(await readFile(file, 'utf8'))) findings.push({ file, ...finding });
	}
	return findings;
}

/** Literal counts per rule and file, in a stable order for the baseline. */
function count(findings) {
	const counts = Object.fromEntries(RULES.map(({ name }) => [name, {}]));
	for (const { rule, file } of findings) counts[rule][file] = (counts[rule][file] ?? 0) + 1;
	return counts;
}

if (import.meta.main) {
	const findings = await scan();
	const counts = count(findings);
	if (process.argv.includes('--write')) {
		await writeFile(BASELINE_PATH, `${JSON.stringify(counts, null, '\t')}\n`);
		const totals = RULES.map(({ name }) => `${Object.values(counts[name]).reduce((sum, value) => sum + value, 0)} ${name}`);
		console.log(`Recorded ${totals.join(', ')} literals in ${BASELINE_PATH}.`);
	} else {
		const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
		for (const { name, hint } of RULES) {
			const actual = counts[name];
			const allowed = baseline[name] ?? {};
			const files = [...new Set([...Object.keys(allowed), ...Object.keys(actual)])].sort();
			const added = files.filter(file => (actual[file] ?? 0) > (allowed[file] ?? 0));
			const removed = files.filter(file => (actual[file] ?? 0) < (allowed[file] ?? 0));
			if (added.length) {
				console.error(`${hint}`);
				for (const { file, line, declaration } of findings.filter(finding => finding.rule === name && added.includes(finding.file))) {
					console.error(`- ${file}:${line} ${declaration}`);
				}
				process.exitCode = 1;
			}
			if (removed.length) {
				console.error(`${name} literals were removed from ${removed.join(', ')}. Run \`${WRITE_COMMAND}\` to lower the baseline.`);
				process.exitCode = 1;
			}
		}
		if (process.exitCode) {
			console.error(`If a literal must stay, record it with \`${WRITE_COMMAND}\`.`);
		} else {
			console.log('Fonts, layers, motion, radii and spacing use the shared roles or a recorded literal.');
		}
	}
}
