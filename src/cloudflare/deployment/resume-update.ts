import type { CloudflareApiClient } from '../cloudflare-api';
import type { CloudflareDeploymentArtifacts } from './artifacts';
import { completePublishedDeployment } from './complete-published';
import { provisionCloudflareDeployment } from './provisioner';
import { recoverDeployment, type DeploymentRecoveryResult } from './recovery';
import type { CloudflareDeploymentMetadata } from './types';

/** Finish an update that a previous run left behind its deployment fence, or report why it needs review. */
export async function resumeInterruptedUpdate({ api, metadata, artifacts, whileActive, persist }: {
	api: CloudflareApiClient;
	metadata: CloudflareDeploymentMetadata;
	artifacts: CloudflareDeploymentArtifacts;
	whileActive: <T>(operation: () => Promise<T>) => Promise<T>;
	persist: () => Promise<void>;
}): Promise<DeploymentRecoveryResult> {
	const recovery = await recoverDeployment(api, metadata, artifacts.fingerprint);
	if (recovery.status === 'verify' && recovery.resumeValue) {
		const resumeValue = recovery.resumeValue;
		await whileActive(() => completePublishedDeployment(api, metadata, artifacts, resumeValue));
		await persist();
		return { status: 'recovered', message: 'The previously published update was verified and its lock released. You can now update to the version included with this plugin.', diagnostics: recovery.diagnostics };
	}
	if (recovery.status !== 'resume' || !recovery.resumeValue) return recovery;
	await whileActive(() => provisionCloudflareDeployment({
		api, accountId: metadata.accountId!, metadata, artifacts,
		resumeUpdateValue: recovery.resumeValue,
		onMetadataChanged: persist,
	}));
	return { status: 'completed', message: 'The interrupted server update was completed and verified.', diagnostics: recovery.diagnostics };
}
