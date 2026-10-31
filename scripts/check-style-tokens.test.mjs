import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLiteralFontDeclarations } from './check-style-tokens.mjs';

const declarations = source => findLiteralFontDeclarations(source).map(({ line, declaration }) => `${line} ${declaration}`);

test('reports absolute font sizes, numeric weights and shorthand literals with their lines', () => {
	assert.deepEqual(declarations([
		'.a { font-size: 13px; font-weight: 500; }',
		'.b {',
		'  font-size: clamp(28px, 3.1vw, 42px);',
		'  font: 500 13px/1 var(--font-interface);',
		'}',
	].join('\n')), [
		'1 font-size: 13px',
		'1 font-weight: 500',
		'3 font-size: clamp(28px, 3.1vw, 42px)',
		'4 font: 500 13px/1 var(--font-interface)',
	]);
});

test('allows roles, fallbacks, relative sizes, keywords and role definitions', () => {
	assert.deepEqual(declarations([
		'.a { font-size: var(--crate-font-sm); font-weight: var(--crate-font-weight-medium); }',
		'.b { font-size: var(--crate-font-xs, var(--font-ui-smaller, 12px)); font: var(--crate-font-base, 15px)/1.5 var(--font-interface); }',
		'.c { font-size: 1.35em; font-weight: bold; font: inherit; }',
		'.d { --crate-font-base: 16px; --crate-action-font-size: 14px; --crate-font-weight-medium: 600; }',
		'.e__font-size:hover { color: red; }',
	].join('\n')), []);
});

test('ignores commented-out declarations', () => {
	assert.deepEqual(declarations([
		'// .a { font-size: 13px; }',
		'/* .b { font-weight: 500; }',
		'   .c { font-size: 12px; } */',
		'.d { background: url(https://example.test/a.png); font-size: 11px; }',
	].join('\n')), ['4 font-size: 11px']);
});
