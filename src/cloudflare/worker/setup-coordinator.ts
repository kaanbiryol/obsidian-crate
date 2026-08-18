import { sha256Hex, timingSafeEqual } from './auth';
import { handleRegisterToken } from './auth-handlers';
import { corsResponse } from './cors';
import type { Env } from './types';
import { isSha256Hex, parseJsonObject, parseOptionalString } from './utils';

const SETUP_STATE_KEY = 'setup-state';
const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

interface SetupState {
	claimed: true;
	enrollmentTokenHash: string | null;
	enrollmentExpiresAt: number | null;
}

function normalizeSetupState(value: unknown): SetupState | null {
	if (!value || typeof value !== 'object') return null;
	const state = value as Partial<SetupState>;
	if (state.claimed !== true) return null;
	const hash = typeof state.enrollmentTokenHash === 'string' && isSha256Hex(state.enrollmentTokenHash)
		? state.enrollmentTokenHash.toLowerCase()
		: null;
	const expiresAt = typeof state.enrollmentExpiresAt === 'number' && Number.isFinite(state.enrollmentExpiresAt)
		? state.enrollmentExpiresAt
		: null;
	return {
		claimed: true,
		enrollmentTokenHash: hash,
		enrollmentExpiresAt: expiresAt,
	};
}

export class SetupCoordinator implements DurableObject {
	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Pick<Env, 'DB'>,
	) {}

	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === '/setup/status' && request.method === 'GET') return await this.handleStatus();
		if (path === '/setup/claim' && request.method === 'POST') return await this.handleClaim(request);
		if (path === '/setup/authorize-enrollment' && request.method === 'POST') {
			return await this.handleAuthorizeEnrollment(request);
		}
		if (path === '/setup/enroll' && request.method === 'POST') return await this.handleEnroll(request);
		return corsResponse({ error: 'Not found' }, 404);
	}

	private async readState(): Promise<SetupState | null> {
		return normalizeSetupState(await this.state.storage.get(SETUP_STATE_KEY));
	}

	private async handleStatus(): Promise<Response> {
		const state = await this.readState();
		if (!state) {
			return corsResponse({ claimed: false, enrollmentAvailable: false });
		}

		const enrollmentAvailable = state.enrollmentTokenHash !== null
			&& state.enrollmentExpiresAt !== null
			&& state.enrollmentExpiresAt > Date.now();
		if (!enrollmentAvailable && state.enrollmentTokenHash !== null) {
			await this.state.storage.put<SetupState>(SETUP_STATE_KEY, {
				claimed: true,
				enrollmentTokenHash: null,
				enrollmentExpiresAt: null,
			});
		}
		return corsResponse({
			claimed: true,
			enrollmentAvailable,
			...(enrollmentAvailable && { enrollmentTokenHash: state.enrollmentTokenHash }),
		});
	}

	private async handleClaim(request: Request): Promise<Response> {
		if (await this.readState()) {
			return corsResponse({ error: 'Server already claimed' }, 409);
		}

		const parsedBody = await parseJsonObject(request);
		if (!parsedBody.ok) return parsedBody.response;
		const enrollmentTokenHash = parseOptionalString(parsedBody.value.enrollmentTokenHash, 64)?.toLowerCase() || '';
		if (!isSha256Hex(enrollmentTokenHash)) {
			return corsResponse({ error: 'Valid enrollmentTokenHash required' }, 400);
		}

		const expiresAt = Date.now() + ENROLLMENT_TTL_MS;
		await this.state.storage.put<SetupState>(SETUP_STATE_KEY, {
			claimed: true,
			enrollmentTokenHash,
			enrollmentExpiresAt: expiresAt,
		});
		return corsResponse({ claimed: true, expiresAt: new Date(expiresAt).toISOString() });
	}

	private async handleAuthorizeEnrollment(request: Request): Promise<Response> {
		const state = await this.readState();
		if (!state) {
			return corsResponse({ error: 'Server is not claimed' }, 409);
		}

		const parsedBody = await parseJsonObject(request);
		if (!parsedBody.ok) return parsedBody.response;
		const enrollmentTokenHash = parseOptionalString(parsedBody.value.enrollmentTokenHash, 64)?.toLowerCase() || '';
		if (!isSha256Hex(enrollmentTokenHash)) {
			return corsResponse({ error: 'Valid enrollmentTokenHash required' }, 400);
		}

		const expiresAt = Date.now() + ENROLLMENT_TTL_MS;
		await this.state.storage.put<SetupState>(SETUP_STATE_KEY, {
			claimed: true,
			enrollmentTokenHash,
			enrollmentExpiresAt: expiresAt,
		});
		return corsResponse({ expiresAt: new Date(expiresAt).toISOString() });
	}

	private async handleEnroll(request: Request): Promise<Response> {
		const parsedBody = await parseJsonObject(request);
		if (!parsedBody.ok) return parsedBody.response;
		const enrollmentToken = parseOptionalString(parsedBody.value.enrollmentToken, 256);
		const deviceTokenHash = parseOptionalString(parsedBody.value.deviceTokenHash, 64)?.toLowerCase() || '';
		if (!enrollmentToken || !isSha256Hex(deviceTokenHash)) {
			return corsResponse({ error: 'Valid enrollment and device tokens required' }, 400);
		}

		const state = await this.readState();
		if (
			!state?.enrollmentTokenHash
			|| !state.enrollmentExpiresAt
			|| state.enrollmentExpiresAt <= Date.now()
			|| !await timingSafeEqual(await sha256Hex(enrollmentToken), state.enrollmentTokenHash)
		) {
			return corsResponse({ error: 'Invalid or expired enrollment token' }, 401);
		}
		if (!this.env.DB) {
			return corsResponse({ error: 'Database not available' }, 503);
		}

		const consumedState: SetupState = {
			claimed: true,
			enrollmentTokenHash: null,
			enrollmentExpiresAt: null,
		};
		await this.state.storage.put(SETUP_STATE_KEY, consumedState);

		try {
			const registrationRequest = new Request('https://crate.internal/auth/tokens', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					token_hash: deviceTokenHash,
					device_id: parsedBody.value.deviceId,
					device_name: parsedBody.value.deviceName,
					platform: parsedBody.value.platform,
				}),
			});
			const response = await handleRegisterToken(registrationRequest, this.env.DB);
			if (!response.ok) {
				await this.state.storage.put(SETUP_STATE_KEY, state);
			}
			return response;
		} catch {
			await this.state.storage.put(SETUP_STATE_KEY, state);
			return corsResponse({ error: 'Enrollment failed' }, 503);
		}
	}
}
