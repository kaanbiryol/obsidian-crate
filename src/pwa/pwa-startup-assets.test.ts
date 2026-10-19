import { describe, expect, it } from 'vitest';
import { getPwaClientAssets, getPwaOnDemandAssets, getPwaStartupAssets } from '../../scripts/pwa-startup-assets.mjs';

const staticImport = (path: string) => ({ path, kind: 'import-statement' });

describe('PWA startup assets', () => {
	it('includes transitive static dependencies once and excludes lazy-only chunks', () => {
		const outputs = {
			'pwa-client/app.js': { imports: [
				staticImport('pwa-client/shared.js'),
				staticImport('pwa-client/runtime.js'),
				{ path: 'pwa-client/settings.js', kind: 'dynamic-import' },
			] },
			'pwa-client/shared.js': { imports: [staticImport('pwa-client/runtime.js')] },
			'pwa-client/runtime.js': { imports: [staticImport('pwa-client/shared.js')] },
			'pwa-client/settings.js': { imports: [staticImport('pwa-client/settings-only.js')] },
			'pwa-client/settings-only.js': { imports: [] },
			// A build-only entry may force a static boundary without being served.
			'pwa-client/editor-facade.js': { imports: [staticImport('pwa-client/shared.js')] },
		};
		expect(getPwaStartupAssets({ outputs })).toEqual(['app.js', 'shared.js', 'runtime.js']);
		expect(getPwaClientAssets({ outputs })).toEqual(['app.js', 'shared.js', 'runtime.js', 'settings.js', 'settings-only.js']);
	});

	it('keeps article extraction out of precache unless another lazy path shares it', () => {
		const outputs = {
			'pwa-client/app.js': { imports: [{ path: 'pwa-client/reading.js', kind: 'dynamic-import' }] },
			'pwa-client/reading.js': { imports: [
				{ path: 'pwa-client/extract.js', kind: 'dynamic-import' },
				staticImport('pwa-client/shared.js'),
			] },
			'pwa-client/extract.js': { entryPoint: 'src/reading/extraction/document.ts', imports: [
				staticImport('pwa-client/defuddle.js'),
				staticImport('pwa-client/shared.js'),
			] },
			'pwa-client/defuddle.js': { imports: [] },
			'pwa-client/shared.js': { imports: [] },
		};
		expect(getPwaOnDemandAssets({ outputs })).toEqual(['extract.js', 'defuddle.js']);
	});

	it('fails when the startup graph is incomplete instead of undercounting its size', () => {
		expect(() => getPwaStartupAssets({ outputs: {} })).toThrow('app.js');
		expect(() => getPwaStartupAssets({ outputs: {
			'app.js': { imports: [staticImport('missing.js')] },
		} })).toThrow('missing.js');
	});
});
