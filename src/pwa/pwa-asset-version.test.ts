import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPwaAssetVersion } from '../../scripts/pwa-asset-version.mjs';

const roots: string[] = [];

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'crate-pwa-version-'));
	roots.push(root);
	const write = (path: string, source: string) => {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, source);
	};
	write('src/cloudflare/worker/pwa/styles/theme.css', ':root { --accent: purple; }');
	write('src/pwa/styles/reminders-view.scss', '@use "../../ui/shared/styles/tokens"; .crate-reminders-ui { @include tokens.styles; }');
	write('src/ui/shared/styles/_tokens.scss', '@mixin styles { --crate-radius-card: 10px; }');
	return { root, write };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PWA asset version', () => {
	it('invalidates cached HTML when a transitive shared stylesheet changes', () => {
		const { root, write } = fixture();
		const assets = { 'app.js': 'same client JavaScript' };
		const before = createPwaAssetVersion(assets, root);
		write('src/ui/shared/styles/_tokens.scss', '@mixin styles { --crate-radius-card: 12px; }');
		expect(createPwaAssetVersion(assets, root)).not.toBe(before);
	});

	it('still invalidates for Worker styles and client chunks', () => {
		const { root, write } = fixture();
		const assets = { 'app.js': 'app', 'chunk.js': 'original chunk' };
		const before = createPwaAssetVersion(assets, root);
		expect(createPwaAssetVersion({ ...assets, 'chunk.js': 'new chunk' }, root)).not.toBe(before);
		write('src/cloudflare/worker/pwa/styles/theme.css', ':root { --accent: blue; }');
		expect(createPwaAssetVersion(assets, root)).not.toBe(before);
	});

	it('is stable across asset ordering and plugin-only changes', () => {
		const { root, write } = fixture();
		const before = createPwaAssetVersion({ 'app.js': 'app', 'chunk.js': 'chunk' }, root);
		write('src/styles/plugin-ui/_theme.scss', '.plugin-only { color: red; }');
		expect(createPwaAssetVersion({ 'chunk.js': 'chunk', 'app.js': 'app' }, root)).toBe(before);
	});
});
