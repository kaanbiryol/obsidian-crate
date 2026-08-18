import type { SharedSettings, WorkerConfig } from '../plugin/types';
import { isCompatibleCrateServer, type CrateServerInfo } from '../protocol';
import { SyncApiClient } from './api';
import { generateSecureToken, hashToken } from './device-token';
import { requireNormalizedWorkerUrl } from './worker-url';

const DEVICE_ENROLLMENT_CAPABILITY = 'enrollment-v1';

interface DeviceEnrollmentInput {
	workerUrl: string;
	enrollmentToken: string;
	deviceId?: string;
	deviceName?: string;
	platform?: string;
}

interface DeviceEnrollmentResult {
	workerUrl: string;
	authToken: string;
	config: WorkerConfig;
	sharedSettings: SharedSettings | null;
}

interface EnrollmentClient {
	getServerInfo(): Promise<CrateServerInfo>;
	enrollDevice(input: {
		enrollmentToken: string;
		deviceTokenHash: string;
		deviceId?: string;
		deviceName?: string;
		platform?: string;
	}): Promise<{ id: string }>;
	testConnection(): Promise<{ success: boolean; error?: string }>;
	getConfig(): Promise<WorkerConfig>;
	getSharedSettings(): Promise<{ settings: SharedSettings | null }>;
}

interface EnrollmentDependencies {
	createClient(workerUrl: string, authToken: string): EnrollmentClient;
	generateToken(): string;
	hashToken(token: string): Promise<string>;
}

const DEFAULT_WORKER_CONFIG: WorkerConfig = Object.freeze({
	accountId: null,
	workerName: null,
	bucketName: null,
	databaseId: null,
});

const DEFAULT_DEPENDENCIES: EnrollmentDependencies = {
	createClient: (workerUrl, authToken) => new SyncApiClient(workerUrl, authToken),
	generateToken: generateSecureToken,
	hashToken,
};

export async function exchangeDeviceEnrollment(
	input: DeviceEnrollmentInput,
	dependencies: EnrollmentDependencies = DEFAULT_DEPENDENCIES,
): Promise<DeviceEnrollmentResult> {
	const workerUrl = requireNormalizedWorkerUrl(input.workerUrl);
	const enrollmentToken = input.enrollmentToken.trim();
	if (!enrollmentToken) {
		throw new Error('Enrollment token is required');
	}

	const publicClient = dependencies.createClient(workerUrl, '');
	const serverInfo = await publicClient.getServerInfo();
	if (!isCompatibleCrateServer(serverInfo)) {
		throw new Error(`Incompatible Crate server protocol ${serverInfo.protocol.current}`);
	}
	if (!serverInfo.capabilities.includes(DEVICE_ENROLLMENT_CAPABILITY)) {
		throw new Error('Crate server does not support secure device enrollment');
	}

	const authToken = dependencies.generateToken();
	const deviceTokenHash = await dependencies.hashToken(authToken);
	const authenticatedClient = dependencies.createClient(workerUrl, authToken);

	try {
		await publicClient.enrollDevice({
			enrollmentToken,
			deviceTokenHash,
			deviceId: input.deviceId,
			deviceName: input.deviceName,
			platform: input.platform,
		});
	} catch (error) {
		const connection = await authenticatedClient.testConnection();
		if (!connection.success) {
			throw error;
		}
	}

	let config: WorkerConfig = DEFAULT_WORKER_CONFIG;
	let sharedSettings: SharedSettings | null = null;
	try {
		config = await authenticatedClient.getConfig();
	} catch { /* optional metadata */ }
	try {
		({ settings: sharedSettings } = await authenticatedClient.getSharedSettings());
	} catch { /* optional shared settings */ }

	return {
		workerUrl,
		authToken,
		config,
		sharedSettings,
	};
}

export type {
	DeviceEnrollmentInput,
	DeviceEnrollmentResult,
	EnrollmentClient,
	EnrollmentDependencies,
};
