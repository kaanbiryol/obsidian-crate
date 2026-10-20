import { describe, expect, it } from 'vitest';
import { DeploymentFence, DeploymentRecoveryRequiredError } from './fence';

const record = JSON.stringify({ owner: 'device', worker: 'crate-server', kind: 'update', version: '1', startedAt: '2026-01-01T00:00:00.000Z' });

describe('DeploymentFence', () => {
	it('keeps the D1 failure as the cause when a step cannot be checkpointed', async () => {
		const failure = new Error('D1 unavailable');
		const fence = new DeploymentFence({ queryD1: async () => { throw failure; } }, 'account', 'database', record);
		const error = await fence.checkpoint('upload-worker').catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DeploymentRecoveryRequiredError);
		expect((error as Error).cause).toBe(failure);
	});

	it('keeps the D1 failure as the cause when release cannot be confirmed', async () => {
		const failure = new Error('D1 unavailable');
		const fence = new DeploymentFence({ queryD1: async () => { throw failure; } }, 'account', 'database', record);
		const error = await fence.finish().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DeploymentRecoveryRequiredError);
		expect((error as Error).cause).toBe(failure);
	});
});
