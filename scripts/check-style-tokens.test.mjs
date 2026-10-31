import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLiteralDeclarations } from './check-style-tokens.mjs';

const declarations = source => findLiteralDeclarations(source).map(({ rule, line, declaration }) => `${line} ${rule} ${declaration}`);

test('reports absolute font sizes, numeric weights and shorthand literals with their lines', () => {
	assert.deepEqual(declarations([
		'.a { font-size: 13px; font-weight: 500; }',
		'.b {',
		'  font-size: clamp(28px, 3.1vw, 42px);',
		'  font: 500 13px/1 var(--font-interface);',
		'}',
	].join('\n')), [
		'1 font font-size: 13px',
		'1 font font-weight: 500',
		'3 font font-size: clamp(28px, 3.1vw, 42px)',
		'4 font font: 500 13px/1 var(--font-interface)',
	]);
});

test('reports global layers, literal timings, radii and off-scale spacing', () => {
	assert.deepEqual(declarations([
		'.a { z-index: 1000; transition: opacity 200ms ease; border-radius: 999px; padding: 10px 12px; }',
		'.b { animation: settle 1.4s cubic-bezier(.22, 1, .36, 1); margin: -14px 0 0; gap: 3px; }',
	].join('\n')), [
		'1 layer z-index: 1000',
		'1 motion transition: opacity 200ms ease',
		'1 radius border-radius: 999px',
		'1 spacing padding: 10px 12px',
		'2 motion animation: settle 1.4s cubic-bezier(.22, 1, .36, 1)',
		'2 spacing margin: -14px 0 0',
		'2 spacing gap: 3px',
	]);
});

test('allows roles, constants, fallbacks, local stacking and on-scale values', () => {
	assert.deepEqual(declarations([
		'.a { font-size: var(--crate-font-sm); font-weight: var(--crate-font-weight-medium); }',
		'.b { font-size: var(--crate-font-xs, var(--font-ui-smaller, 12px)); font: var(--crate-font-base, 15px)/1.5 var(--font-interface); }',
		'.c { font-size: 1.35em; font-weight: bold; font: inherit; }',
		'.d { --crate-font-base: 16px; --crate-action-font-size: 14px; --pwa-motion-dock-ease: cubic-bezier(.22, .61, .36, 1); }',
		'.e__font-size:hover { color: red; }',
		'.f { z-index: 2; z-index: -1; z-index: tokens.$layer-sheet; z-index: tokens.$layer-sheet + 1; }',
		'.g { transition: none; transition: opacity 0ms; transition: transform var(--pwa-motion-dock-duration) tokens.$easing-settle; }',
		'.h { border-radius: 0; border-radius: 50%; border-radius: var(--crate-radius-card); border-top-left-radius: tokens.$radius-pill; }',
		'.i { padding: 12px 16px; margin: 0 -8px 1px; gap: 24px 40px; padding-inline: var(--crate-space-4, 10px); }',
		'@media (max-width: 360px) { .j { padding: 20px; } }',
	].join('\n')), []);
});

test('ignores commented-out declarations', () => {
	assert.deepEqual(declarations([
		'// .a { font-size: 13px; }',
		'/* .b { font-weight: 500; }',
		'   .c { font-size: 12px; } */',
		'.d { background: url(https://example.test/a.png); font-size: 11px; }',
	].join('\n')), ['4 font font-size: 11px']);
});
