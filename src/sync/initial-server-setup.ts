import { generateSecureToken, hashToken } from './device-token';
import {
	exchangeDeviceEnrollment,
	type DeviceEnrollmentInput,
	type DeviceEnrollmentResult,
} from './enrollment';
import { SyncApiClient } from './api';
import { requireNormalizedWorkerUrl } from './worker-url';

interface InitialServerClient {
	claimInitialServer(enrollmentTokenHash: string): Promise<{ expiresAt: string }>;
}

export interface InitialServerSetupDependencies {
	createClient(workerUrl: string): InitialServerClient;
	createEnrollmentToken(): string;
	hashEnrollmentToken(token: string): Promise<string>;
	exchangeEnrollment(input: DeviceEnrollmentInput): Promise<DeviceEnrollmentResult>;
}

const DEFAULT_DEPENDENCIES: InitialServerSetupDependencies = {
	createClient: workerUrl => new SyncApiClient(workerUrl, ''),
	createEnrollmentToken: generateSecureToken,
	hashEnrollmentToken: hashToken,
	exchangeEnrollment: exchangeDeviceEnrollment,
};

/**
 * Claims a newly deployed server and enrolls this device without sending the
 * one-time token through a browser URL. The token only exists in this call
 * stack and the Worker stores its SHA-256 hash until enrollment consumes it.
 */
export async function claimAndEnrollInitialDevice(
	input: Omit<DeviceEnrollmentInput, 'enrollmentToken'>,
	dependencies: InitialServerSetupDependencies = DEFAULT_DEPENDENCIES,
): Promise<DeviceEnrollmentResult> {
	const workerUrl = requireNormalizedWorkerUrl(input.workerUrl);
	const enrollmentToken = dependencies.createEnrollmentToken();
	const enrollmentTokenHash = await dependencies.hashEnrollmentToken(enrollmentToken);

	let claimError: unknown = null;
	try {
		await dependencies.createClient(workerUrl).claimInitialServer(enrollmentTokenHash);
	} catch (error) {
		// The claim may have succeeded even if its response was interrupted. Try
		// the one-time enrollment before treating the claim as failed.
		claimError = error;
	}

	try {
		return await dependencies.exchangeEnrollment({
			...input,
			workerUrl,
			enrollmentToken,
		});
	} catch (enrollmentError) {
		throw claimError ?? enrollmentError;
	}
}
