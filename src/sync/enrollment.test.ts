import { describe, expect, it, vi } from 'vitest';
import type { CrateServerInfo } from '../protocol';
import {
	exchangeDeviceEnrollment,
	type EnrollmentClient,
	type EnrollmentDependencies,
} from './enrollment';

const COMPATIBLE_SERVER: CrateServerInfo = {
	service: 'crate',
	serverVersion: '1.0.0',
	protocol: { current: 1, oldestCompatible: 1 },
	capabilities: ['sync-v1', 'enrollment-v1'],
};

function createClient(overrides?: Partial<EnrollmentClient>): EnrollmentClient {
	return {
		getServerInfo: vi.fn(async () => COMPATIBLE_SERVER),
		enrollDevice: vi.fn(async () => ({ id: 'device-token-id' })),
		testConnection: vi.fn(async () => ({ success: true })),
		getSharedSettings: vi.fn(async () => ({ settings: null })),
		...overrides,
	};
}

function createDependencies(publicClient: EnrollmentClient, authenticatedClient: EnrollmentClient) {
	const createClientForCredentials = vi.fn((_workerUrl: string, authToken: string) =>
		authToken ? authenticatedClient : publicClient);
	const generateToken = vi.fn(() => 'permanent-device-token');
	const hashToken = vi.fn(async () => 'hashed-permanent-token');
	const dependencies: EnrollmentDependencies = {
		createClient: createClientForCredentials,
		generateToken,
		hashToken,
	};
	return { dependencies, createClientForCredentials, generateToken, hashToken };
}

describe('exchangeDeviceEnrollment', () => {
	it('exchanges a one-time enrollment token for a locally generated device secret', async () => {
		const sharedSettings = {
			ignorePatterns: ['.git/'],
			syncOnStartup: true,
			syncOnResume: true,
			syncInterval: 300,
			showStatusBar: true,
			pushEnabled: false,
		};
		const enrollDevice = vi.fn(async () => ({ id: 'device-token-id' }));
		const testConnection = vi.fn(async () => ({ success: true }));
		const publicClient = createClient({ enrollDevice });
		const authenticatedClient = createClient({
			testConnection,
			getSharedSettings: vi.fn(async () => ({ settings: sharedSettings })),
		});
		const { dependencies, createClientForCredentials, hashToken } = createDependencies(
			publicClient,
			authenticatedClient,
		);

		await expect(exchangeDeviceEnrollment({
			workerUrl: 'https://worker.example/',
			enrollmentToken: ' one-time-token ',
			deviceId: 'device-1',
			deviceName: 'Mac (e-1)',
			platform: 'macos',
		}, dependencies)).resolves.toEqual({
			workerUrl: 'https://worker.example',
			authToken: 'permanent-device-token',
			sharedSettings,
		});

		expect(createClientForCredentials).toHaveBeenNthCalledWith(1, 'https://worker.example', '');
		expect(createClientForCredentials).toHaveBeenNthCalledWith(2, 'https://worker.example', 'permanent-device-token');
		expect(hashToken).toHaveBeenCalledWith('permanent-device-token');
		expect(enrollDevice).toHaveBeenCalledWith({
			enrollmentToken: 'one-time-token',
			deviceTokenHash: 'hashed-permanent-token',
			deviceId: 'device-1',
			deviceName: 'Mac (e-1)',
			platform: 'macos',
		});
		expect(testConnection).not.toHaveBeenCalled();
	});

	it('rejects incompatible servers before generating a device secret', async () => {
		const publicClient = createClient({
			getServerInfo: vi.fn(async () => ({
				...COMPATIBLE_SERVER,
				protocol: { current: 9, oldestCompatible: 9 },
			})),
		});
		const { dependencies, generateToken } = createDependencies(publicClient, createClient());

		await expect(exchangeDeviceEnrollment({
			workerUrl: 'https://worker.example',
			enrollmentToken: 'one-time-token',
		}, dependencies)).rejects.toThrow('Incompatible Crate server protocol 9');
		expect(generateToken).not.toHaveBeenCalled();
	});

	it('rejects servers without secure enrollment support', async () => {
		const publicClient = createClient({
			getServerInfo: vi.fn(async () => ({
				...COMPATIBLE_SERVER,
				capabilities: ['sync-v1'],
			})),
		});
		const { dependencies, generateToken } = createDependencies(publicClient, createClient());

		await expect(exchangeDeviceEnrollment({
			workerUrl: 'https://worker.example',
			enrollmentToken: 'one-time-token',
		}, dependencies)).rejects.toThrow('does not support secure device enrollment');
		expect(generateToken).not.toHaveBeenCalled();
	});

	it('recovers when enrollment succeeds but its response is lost', async () => {
		const testConnection = vi.fn(async () => ({ success: true }));
		const publicClient = createClient({
			enrollDevice: vi.fn(async () => {
				throw new Error('response lost');
			}),
		});
		const authenticatedClient = createClient({
			testConnection,
		});
		const { dependencies } = createDependencies(publicClient, authenticatedClient);

		await expect(exchangeDeviceEnrollment({
			workerUrl: 'https://worker.example',
			enrollmentToken: 'one-time-token',
		}, dependencies)).resolves.toMatchObject({
			authToken: 'permanent-device-token',
		});
		expect(testConnection).toHaveBeenCalledTimes(1);
	});
});
