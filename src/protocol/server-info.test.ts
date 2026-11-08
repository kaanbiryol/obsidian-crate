import { describe, expect, it } from 'vitest';
import {
	areProtocolRangesCompatible,
	CRATE_PLUGIN_PROTOCOL,
	isCompatibleCrateServer,
	isCrateMutation,
	parseCrateServerInfo,
} from './server-info';

it('treats page title lookup as a read', () => {
	expect(isCrateMutation('/links/title', 'POST')).toBe(false);
	expect(isCrateMutation('/reminders/update', 'POST')).toBe(true);
});

describe('Crate protocol contract', () => {
	it('accepts server metadata with a compatible protocol range', () => {
		const info = parseCrateServerInfo({
			service: 'crate',
			serverVersion: '1.2.3',
			protocol: { ...CRATE_PLUGIN_PROTOCOL },
			capabilities: ['sync-v1'],
			serverRevision: 4,
			reminderOperationDay: 20_000,
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
			{ current: CRATE_PLUGIN_PROTOCOL.current + 1, oldestCompatible: CRATE_PLUGIN_PROTOCOL.current + 1 },
		)).toBe(false);
		expect(areProtocolRangesCompatible(
			{ current: 3, oldestCompatible: 2 },
			{ current: 2, oldestCompatible: 1 },
		)).toBe(true);
	});
});

const base = { service: 'crate', serverVersion: 'crate', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [], serverRevision: 43, reminderOperationDay: 20_000 };

it('preserves valid server identity while ignoring malformed optional version fields', () => {
	expect(parseCrateServerInfo({ ...base, deploymentFingerprint: 'a'.repeat(64) }))
		.toMatchObject({ serverRevision: 43, reminderOperationDay: 20_000, deploymentFingerprint: 'a'.repeat(64) });
	expect(parseCrateServerInfo({ ...base, deploymentFingerprint: 'private data' })?.deploymentFingerprint).toBeUndefined();
});

it.each([undefined, 0, -1, 1.5])('rejects metadata whose server revision or operation day is %s', value => {
	expect(parseCrateServerInfo({ ...base, serverRevision: value })).toBeNull();
	expect(parseCrateServerInfo({ ...base, reminderOperationDay: value })).toBeNull();
});
