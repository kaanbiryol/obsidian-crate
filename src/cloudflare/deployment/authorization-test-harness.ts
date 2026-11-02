import type { WithCloudflareAuthorization } from './service';

let current: WithCloudflareAuthorization | undefined;

/** The service's saved-login option in tests: runs the login chosen with `authorizedBy`. */
export const testAuthorization: WithCloudflareAuthorization = operation => {
	if (!current) throw new Error('Choose a test login with authorizedBy first.');
	return current(operation);
};

/** Chooses the saved login that the next call on `service` uses. */
export function authorizedBy<T>(authorize: WithCloudflareAuthorization, service: T): T {
	current = authorize;
	return service;
}
