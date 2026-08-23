import { describe, expect, it, vi } from 'vitest';
import {
	claimAndEnrollInitialDevice,
	type InitialServerSetupDependencies,
} from './initial-server-setup';
import type { DeviceEnrollmentInput, DeviceEnrollmentResult } from './enrollment';

function createHarness(
	claim: (enrollmentTokenHash: string) => Promise<{ expiresAt: string }> = async () =>
		({ expiresAt: '2026-08-23T12:10:00.000Z' }),
) {
	const claimInitialServer = vi.fn(claim);
	const createClient = vi.fn((_workerUrl: string) => ({ claimInitialServer }));
	const createEnrollmentToken = vi.fn(() => 'one-time-enrollment-token');
	const hashEnrollmentToken = vi.fn(async (_token: string) => 'enrollment-token-hash');
	const exchangeEnrollment = vi.fn(async (input: DeviceEnrollmentInput): Promise<DeviceEnrollmentResult> => ({
			workerUrl: input.workerUrl,
			authToken: 'permanent-device-token',
			sharedSettings: null,
		}));
	const dependencies: InitialServerSetupDependencies = {
		createClient,
		createEnrollmentToken,
		hashEnrollmentToken,
		exchangeEnrollment,
	};
	return { dependencies, createClient, claimInitialServer, exchangeEnrollment };
}

describe('claimAndEnrollInitialDevice', () => {
	it('claims and enrolls the first device without putting an enrollment token in a URL', async () => {
		const harness = createHarness();

		await expect(claimAndEnrollInitialDevice({
			workerUrl: 'https://worker.example/',
			deviceId: 'device-1',
		}, harness.dependencies)).resolves.toMatchObject({
			authToken: 'permanent-device-token',
		});

		expect(harness.createClient).toHaveBeenCalledWith('https://worker.example');
		expect(harness.claimInitialServer).toHaveBeenCalledWith('enrollment-token-hash');
		expect(harness.exchangeEnrollment).toHaveBeenCalledWith({
			workerUrl: 'https://worker.example',
			deviceId: 'device-1',
			enrollmentToken: 'one-time-enrollment-token',
		});
	});

	it('finishes enrollment when the claim response is lost after the Worker accepted it', async () => {
		const harness = createHarness(async () => {
			throw new Error('response lost');
		});

		await expect(claimAndEnrollInitialDevice({ workerUrl: 'https://worker.example' }, harness.dependencies))
			.resolves.toMatchObject({ authToken: 'permanent-device-token' });
		expect(harness.exchangeEnrollment).toHaveBeenCalledTimes(1);
	});
});
