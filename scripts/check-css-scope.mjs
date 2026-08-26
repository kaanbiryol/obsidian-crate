import { readFile } from 'node:fs/promises';
import postcss from 'postcss';

const STYLES_PATH = 'dist/styles.css';
const OWNED_SELECTOR_FRAGMENT = '.crate-';

function splitSelectorList(selector) {
	const selectors = [];
	let start = 0;
	let parenthesesDepth = 0;
	let bracketsDepth = 0;
	let quote = '';

	for (let index = 0; index < selector.length; index += 1) {
		const character = selector[index];
		if (quote) {
			if (character === quote && selector[index - 1] !== '\\') {
				quote = '';
			}
			continue;
		}

		if (character === '"' || character === "'") {
			quote = character;
		} else if (character === '(') {
			parenthesesDepth += 1;
		} else if (character === ')') {
			parenthesesDepth -= 1;
		} else if (character === '[') {
			bracketsDepth += 1;
		} else if (character === ']') {
			bracketsDepth -= 1;
		} else if (character === ',' && parenthesesDepth === 0 && bracketsDepth === 0) {
			selectors.push(selector.slice(start, index).trim());
			start = index + 1;
		}
	}

	selectors.push(selector.slice(start).trim());
	return selectors;
}

function isInsideKeyframes(rule) {
	let parent = rule.parent;
	while (parent) {
		if (parent.type === 'atrule' && /keyframes$/i.test(parent.name)) {
			return true;
		}
		parent = parent.parent;
	}
	return false;
}

const stylesheet = postcss.parse(await readFile(STYLES_PATH, 'utf8'), { from: STYLES_PATH });
const unownedSelectors = new Set();
const generatedSelectors = new Set();

stylesheet.walkRules((rule) => {
	if (isInsideKeyframes(rule)) {
		return;
	}

	for (const selector of splitSelectorList(rule.selector)) {
		generatedSelectors.add(selector);
		if (!selector.includes(OWNED_SELECTOR_FRAGMENT)) {
			unownedSelectors.add(selector);
		}
	}
});

if (unownedSelectors.size > 0) {
	console.error('Found CSS selectors outside a Crate-owned scope:');
	for (const selector of [...unownedSelectors].sort()) {
		console.error(`- ${selector}`);
	}
	process.exitCode = 1;
} else {
	console.log(`All selectors in ${STYLES_PATH} are scoped to Crate-owned classes.`);
}

const requiredSameNodeSelectors = [
	'.crate-reminders-ui.reminders-shadow-root',
	'.crate-reminders-ui.heroui-portal-container',
];
const missingSameNodeSelectors = requiredSameNodeSelectors.filter(
	(selector) => !generatedSelectors.has(selector),
);

if (missingSameNodeSelectors.length > 0) {
	console.error('Missing same-node selectors required by Shadow DOM mounts:');
	for (const selector of missingSameNodeSelectors) {
		console.error(`- ${selector}`);
	}
	process.exitCode = 1;
} else {
	console.log('Shadow DOM mount selectors target their classes on the same element.');
}
