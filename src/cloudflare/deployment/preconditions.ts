import { stableJson } from '../../platform/stable-json';
import type { CloudflareDeploymentMetadata, DeploymentIntent, DeploymentRequest, SavedDeploymentIntent } from './types';

/** The plugin's saved server, if any. */
type SavedServer = CloudflareDeploymentMetadata | null | undefined;

/** The saved server operation that must finish before `intent` can run. A deletion admits only deletion. */
export function blockingServerOperation(saved: SavedServer, intent: DeploymentIntent): 'deletion' | null {
	return saved?.deletion && intent !== 'delete' ? 'deletion' : null;
}

const resumeBeforeStarting = { deletion: 'Resume server deletion before connecting or updating.' };
const resumeBeforeContinuing = { deletion: 'Resume server deletion before continuing.' };

/** Before a browser authorization starts for `intent`. */
export function assertDeploymentCanStart(saved: SavedServer, intent: DeploymentIntent): void {
	const blocking = blockingServerOperation(saved, intent);
	if (blocking) throw new Error(resumeBeforeStarting[blocking]);
	if (intent === 'delete' && (!saved?.accountId || !saved.d1DatabaseId)) {
		throw new Error('Connect to a Crate server before resetting its remote data.');
	}
	if (intent === 'reconnect' && (!saved?.accountId || !saved.d1DatabaseId)) throw new Error('Connect a Cloudflare server first.');
}

/** Refuse a request whose saved server changed or gained a pending deletion during authorization. */
export function assertRequestCurrent(saved: SavedServer, request: DeploymentRequest): void {
	const blocking = blockingServerOperation(saved, request.intent);
	if (blocking) throw new Error(resumeBeforeStarting[blocking]);
	if (request.intent === 'delete' && stableJson(request.metadata) !== stableJson(saved)) {
		throw new Error('Server settings changed during authorization. Confirm the deletion again.');
	}
	if ((request.intent === 'switch' || request.intent === 'create') && request.originalMetadata !== stableJson(saved)) throw new Error('Server settings changed during authorization. Start again.');
	if (request.intent === 'reconnect') assertSavedTarget(saved, request.metadata, request.intent);
}

/** Before an operation with the saved login starts. */
export function assertSavedAuthorizationCanStart(saved: SavedServer, intent: SavedDeploymentIntent): asserts saved is CloudflareDeploymentMetadata {
	if (!saved?.accountId) throw new Error('Connect a Cloudflare server first.');
	assertSavedTarget(saved, saved, intent);
	if (intent === 'delete' && !saved.d1DatabaseId) throw new Error('Connect a Cloudflare server first.');
}

/** Once the saved login is ready: the request still targets the unchanged saved server. */
export function assertSavedRequestCurrent(saved: SavedServer, request: DeploymentRequest): void {
	assertSavedTarget(saved, request.metadata, request.intent);
	if (stableJson(saved) !== request.originalMetadata) throw new Error('Server settings changed. Confirm the operation again.');
}

/** A saved server with its account and, unless `accountOnly`, its database and no pending
 * deletion. Anything else is rejected with `required.missing`. */
export function assertSavedServer(saved: SavedServer, required: { missing: string; accountOnly?: boolean }): asserts saved is CloudflareDeploymentMetadata {
	if (!saved?.accountId || !required.accountOnly && (!saved.d1DatabaseId || saved.deletion)) throw new Error(required.missing);
}

const startAgain = (intent: DeploymentIntent) => intent === 'update' ? 'Start the update again.'
	: intent === 'delete' ? 'Start the deletion again.' : 'Start again.';

/** The saved server is still `expected`, with no deletion blocking `intent`. */
export function assertSavedTarget(saved: SavedServer, expected: CloudflareDeploymentMetadata, intent: DeploymentIntent): void {
	const blocking = blockingServerOperation(saved, intent);
	if (blocking) throw new Error(resumeBeforeContinuing[blocking]);
	if (!saved || saved.accountId !== expected.accountId || saved.workerName !== expected.workerName
		|| saved.d1DatabaseId !== expected.d1DatabaseId || saved.r2BucketName !== expected.r2BucketName
		|| expected.deletion && saved.deletion?.id !== expected.deletion.id) {
		throw new Error(`Server settings changed. ${startAgain(intent)}`);
	}
}
