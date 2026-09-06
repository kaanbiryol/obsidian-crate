import { describe, expect, it } from 'vitest';
import {
	areProtocolRangesCompatible,
	CRATE_PLUGIN_PROTOCOL,
	isCompatibleCrateServer,
	parseCrateServerInfo,
} from './protocol';

describe('Crate protocol contract', () => {
	it('accepts server metadata with a compatible protocol range', () => {
		const info = parseCrateServerInfo({
			service: 'crate',
			serverVersion: '1.2.3',
			protocol: { ...CRATE_PLUGIN_PROTOCOL },
			capabilities: ['sync-v1'],
		});

		expect(info).not.toBeNull();
		expect(info && isCompatibleCrateServer(info)).toBe(true);
	});

	it('rejects malformed server metadata', () => {
		expect(parseCrateServerInfo({ service: 'other' })).toBeNull();
		expect(parseCrateServerInfo({
			service: 'crate',
			serverVersion: '1.2.3',
			protocol: { current: 1, oldestCompatible: 2 },
			capabilities: [],
		})).toBeNull();
	});

	it('requires the plugin and server compatibility ranges to overlap', () => {
		expect(areProtocolRangesCompatible(
			CRATE_PLUGIN_PROTOCOL,
			{ current: 1, oldestCompatible: 1 },
		)).toBe(false);
		expect(areProtocolRangesCompatible(
			{ current: 3, oldestCompatible: 2 },
			{ current: 2, oldestCompatible: 1 },
		)).toBe(true);
	});
});
