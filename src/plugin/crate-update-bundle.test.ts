import { describe, expect, it } from 'vitest';
import {
	type CrateUpdateBundle,
	buildCrateUpdate,
	compareVersions,
	crateUpdatePath,
	crateUpdateVersion,
	parseCrateUpdate,
	serializeCrateUpdate,
} from './crate-update-bundle';

type Mutable = Omit<CrateUpdateBundle, 'format'> & { format: number };
const manifest = (version: string, id = 'crate') => JSON.stringify({ id, name: 'Crate', version, minAppVersion: '1.13.0' });
const files = (version: string) => ({ 'main.js': `console.log("${version}")`, 'styles.css': '.crate {}', 'manifest.json': manifest(version) });

describe('crate update bundle', () => {
	it('round-trips a release with deterministic bytes', async () => {
		const text = serializeCrateUpdate(await buildCrateUpdate(files('1.2.3')));
		expect(serializeCrateUpdate(await buildCrateUpdate(files('1.2.3')))).toBe(text);
		const bundle = await parseCrateUpdate(text, 'crate');
		expect(bundle.version).toBe('1.2.3');
		expect(bundle.files['main.js'].content).toBe('console.log("1.2.3")');
	});

	it('rejects a file that does not match its hash', async () => {
		const bundle = JSON.parse(serializeCrateUpdate(await buildCrateUpdate(files('1.2.3')))) as Mutable;
		bundle.files['main.js'].content = 'steal()';
		await expect(parseCrateUpdate(JSON.stringify(bundle), 'crate')).rejects.toThrow('main.js does not match');
	});

	it('rejects a bundle whose fields disagree with its manifest', async () => {
		const bundle = JSON.parse(serializeCrateUpdate(await buildCrateUpdate(files('1.2.3')))) as Mutable;
		bundle.version = '9.0.0';
		await expect(parseCrateUpdate(JSON.stringify(bundle), 'crate')).rejects.toThrow('manifest does not match');
	});

	it('rejects another plugin, a missing file and other formats', async () => {
		const other = await buildCrateUpdate({ ...files('1.2.3'), 'manifest.json': manifest('1.2.3', 'other') });
		await expect(parseCrateUpdate(serializeCrateUpdate(other), 'crate')).rejects.toThrow('another plugin');
		const missing = JSON.parse(serializeCrateUpdate(await buildCrateUpdate(files('1.2.3')))) as Mutable;
		delete (missing.files as Partial<CrateUpdateBundle['files']>)['styles.css'];
		await expect(parseCrateUpdate(JSON.stringify(missing), 'crate')).rejects.toThrow('missing styles.css');
		await expect(parseCrateUpdate(JSON.stringify({ ...missing, format: 2 }), 'crate')).rejects.toThrow('Unsupported');
		await expect(parseCrateUpdate('not json', 'crate')).rejects.toThrow('not valid JSON');
	});

	it('reads versions only from bundle names', () => {
		expect(crateUpdateVersion(crateUpdatePath('.obsidian', '0.10.0'), '.obsidian')).toBe('0.10.0');
		expect(crateUpdateVersion('.obsidian/crate-update/0.10.0 (conflict).json', '.obsidian')).toBeNull();
		expect(crateUpdateVersion('.obsidian/crate-update/v1.0.0.json', '.obsidian')).toBeNull();
		expect(crateUpdateVersion('.obsidian/plugins/crate/1.0.0.json', '.obsidian')).toBeNull();
	});

	it('compares versions numerically', () => {
		expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
		expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
		expect(compareVersions('1.2.3', '1.10.0')).toBe(-1);
	});
});
