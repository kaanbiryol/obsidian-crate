import { canReplaceServerBuild } from '../../protocol/server-build';
import { DEPLOYMENT_FENCE_KEY } from '../../protocol/deployment-fence';
import { isSha256Hex } from '../../platform/validation';
import { CloudflareApiError, type CloudflareApiClient, type CloudflareWorkerSettings } from '../cloudflare-api';
import type { CloudflareDeploymentArtifacts } from './artifacts';
import { inspectDeploymentDatabase, recordDeploymentRelease, readDeploymentBuild } from './database';
import { SERVER_RELEASE } from './database-upgrades';
import {
	awaitsPublicationVerification, type DeploymentFenceRecord, DeploymentRecoveryRequiredError, isPendingAddressActivation,
	isRejectedWorkerUpload, isSettledStep, parseFenceRecord, readStoredFence, UPDATE_STEPS, withDeploymentFence,
} from './fence';
import { provisionCloudflareDeployment } from './provisioner';
import type { CloudflareDeploymentMetadata } from './types';
import { releaseUpgradeGuards } from './upgrade-checkpoint';
import { workersDevOrigin } from './worker-origin';
import { releaseWorkerMessage, workerStorageBindings } from './discovery';

type RecoveryApi = Pick<CloudflareApiClient, 'queryD1' | 'getWorkerSettings'>;
export interface DeploymentRecoveryResult {
	status: 'ready' | 'recovered' | 'blocked' | 'resume' | 'verify' | 'completed';
	title?: string;
	resumeValue?: string;
	message: string;
	diagnostics: string;
}
const confirmedSteps = new Set<string>(UPDATE_STEPS);

/** A confirmed checkpoint can be removed conditionally: the old updater must CAS
 * it to "started" before dispatching its next mutation. Pending address activation
 * has a separate read-and-verify recovery path; other started steps stay blocked. */
export async function recoverDeployment(api: RecoveryApi, target: CloudflareDeploymentMetadata, fingerprint?: string): Promise<DeploymentRecoveryResult> {
	if (!target.accountId || !target.d1DatabaseId || target.deletion) throw new Error('Select the original server and finish any pending deletion first.');
	const account = target.accountId;
	const database = target.d1DatabaseId;
	const report: Record<string, unknown> = { worker: target.workerName, database, checkedAt: new Date().toISOString(), currentFingerprint: fingerprint };
	const result = (status: DeploymentRecoveryResult['status'], message: string): DeploymentRecoveryResult =>
		({ status, message, diagnostics: JSON.stringify({ ...report, status }, null, 2) });
	let settings: CloudflareWorkerSettings | null;
	try { settings = await api.getWorkerSettings(account, target.workerName); }
	catch (error) {
		if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
		settings = null; // First installation may stop before creating the Worker.
	}
	const storage = settings && workerStorageBindings(settings);
	if (settings && (storage?.databaseId !== database || storage.bucketName !== target.r2BucketName)) {
		return result('blocked', 'The live server uses different storage. Recovery stopped without changing it.');
	}
	const message = settings?.annotations?.['workers/message'] ?? '';
	const build = /^Crate (\d+\.\d+\.\d+) ([a-f0-9]{64})$/.exec(message);
	if (settings && !build) return result('blocked', 'The live server could not be identified as a supported Crate deployment.');
	report.liveVersion = build?.[1];
	report.liveFingerprint = build?.[2];
	const tables = (await api.queryD1(account, database,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_state';")).flatMap(row => row.results ?? []);
	if (!tables.length) return result('ready', 'No interrupted update is blocking this server.');
	const stored = await readStoredFence(api, account, database);
	if (stored.state === 'none') return result('ready', 'No interrupted update is blocking this server.');
	if (stored.state === 'invalid') return result('blocked', 'The saved operation record is invalid. Copy diagnostics for support.');
	let value = stored.value;
	let record = parseFenceRecord(value);
	if (!record) return result('blocked', 'The saved operation record is unreadable. Copy diagnostics for support.');
	// Only copy bounded operation metadata, never arbitrary database contents.
	for (const key of ['owner', 'kind', 'startedAt', 'step', 'stepState', 'version', 'fingerprint']) {
		if (typeof record[key] === 'string') report[key] = record[key].slice(0, 200);
	}
	if (record.worker !== target.workerName || record.kind !== 'update' || typeof record.owner !== 'string'
		|| !/^[a-f0-9-]{36}$/.test(record.owner)) {
		return result('blocked', 'This record belongs to another operation. No lock was cleared.');
	}
	// A unique tag identifies this single non-retried dispatch, unlike a build
	// fingerprint shared by repeated uploads. Its presence on the live version
	// establishes publication even if the response/checkpoint was lost.
	if (record.recoveryProtocol === 1 && record.verificationPending === true
		&& record.step === 'upload-worker' && record.stepState === 'started'
		&& typeof record.uploadTag === 'string'
		&& /^crate-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.uploadTag)
		&& settings?.annotations?.['workers/tag'] === record.uploadTag
		&& build?.[1] === record.version && build?.[2] === record.fingerprint
		&& fingerprint === record.fingerprint) {
		const confirmed = JSON.stringify({ ...record, stepState: 'confirmed' });
		const changed = (await api.queryD1(account, database,
			'UPDATE maintenance_state SET value = ? WHERE key = ? AND value = ? RETURNING value;',
			[confirmed, DEPLOYMENT_FENCE_KEY, value])).flatMap(row => row.results ?? []);
		if (changed.length !== 1 || changed[0]?.value !== confirmed) {
			return result('blocked', 'The operation changed during the check. Check again to read its latest status.');
		}
		value = confirmed;
		record = { ...record, stepState: 'confirmed' };
		report.stepState = 'confirmed';
	}
	const pendingAddress = isPendingAddressActivation(record);
	const knownStep = confirmedSteps.has(String(record.step)) || SERVER_RELEASE.migrations.some(migration => record.step === `migrate-${migration.id}`);
	if (record.recoveryProtocol === 1 && record.step === 'upload-worker' && record.stepState === 'started') {
		return { ...result('blocked', 'Crate couldn’t confirm whether the previous upload finished. Continuing now could let it overwrite a newer update.'), title: 'Upload status is uncertain' };
	}
	if (record.recoveryProtocol !== 1 || !(isSettledStep(record) || pendingAddress) || !knownStep) {
		return result('blocked', 'Cloudflare has not confirmed that the interrupted request finished. Crate cannot safely resume this update yet.');
	}
	if (record.verificationPending === true) {
		if (build?.[2] === record.fingerprint && build?.[1] === record.version && awaitsPublicationVerification(record)) {
			return { ...result('verify', 'The published update can be verified under new ownership.'), resumeValue: value };
		}
		if (pendingAddress) return result('blocked', 'The pending address activation belongs to a different published build. No lock was cleared.');
		if (fingerprint && isRejectedWorkerUpload(record)) {
			return { ...result('resume', 'The rejected upload can be replaced by this build under new ownership.'), resumeValue: value };
		}
		if (!fingerprint || fingerprint !== record.fingerprint) return result('blocked', 'Resume this update with the exact plugin build that started it. No lock was cleared.');
		return { ...result('resume', 'The confirmed update can resume under new ownership.'), resumeValue: value };
	}
	const removed = (await api.queryD1(account, database,
		'DELETE FROM maintenance_state WHERE key = ? AND value = ? RETURNING key;', [DEPLOYMENT_FENCE_KEY, value])).flatMap(row => row.results ?? []);
	if (removed.length !== 1 || removed[0]?.key !== DEPLOYMENT_FENCE_KEY) {
		return result('blocked', 'The operation changed during the check. Let it finish, then check again.');
	}
	return result('recovered', 'The confirmed operation was recovered. You can now retry the server update.');
}

/** Verify an already-published update and its address. Never upload a replacement build. */
export async function completePublishedDeployment(
	api: Pick<CloudflareApiClient, 'getWorkerSettings' | 'getWorkerSubdomain' | 'queryD1' | 'verifyPublishedWorkerDeployment'>,
	target: CloudflareDeploymentMetadata,
	artifacts: CloudflareDeploymentArtifacts,
	value: string,
): Promise<void> {
	const parsed = parseFenceRecord(value);
	const record = (parsed ?? {}) as Partial<DeploymentFenceRecord>;
	if (!parsed || !target.accountId || !target.d1DatabaseId || record.kind !== 'update'
		|| record.worker !== target.workerName || record.recoveryProtocol !== 1 || record.verificationPending !== true
		|| !record.fingerprint || !isSha256Hex(record.fingerprint) || !record.version || !/^\d+\.\d+\.\d+$/.test(record.version)
		|| !awaitsPublicationVerification(parsed)) throw new Error('This update is not ready for publication verification.');
	const accountId = target.accountId;
	const databaseId = target.d1DatabaseId;
	const fingerprint = record.fingerprint;
	const version = record.version;
	// Resolve the address from the selected server, never from the operation record.
	if (!/^crate-[a-f0-9]{16}$/.test(target.workerName) || !/^[a-z0-9-]+$/.test(target.workersSubdomain ?? '')) {
		throw new Error('The saved server address is invalid.');
	}
	const publishedArtifacts = { ...artifacts, version, fingerprint };
	const verifyAddress = async () => {
		const address = await api.getWorkerSubdomain(accountId, target.workerName);
		if (address.enabled !== true || address.previews_enabled !== false) {
			throw new DeploymentRecoveryRequiredError('Cloudflare has not confirmed the expected server address settings (enabled, with preview URLs disabled). The update lock remains held.');
		}
	};
	// Inspect before replacing an unconfirmed activation, then recheck under our
	// ownership. No activation request is retried, and the old owner cannot advance.
	if (isPendingAddressActivation(parsed)) await verifyAddress();
	let verifiedRevision: number | undefined;
	await withDeploymentFence({ api, accountId, databaseId, resumeUpdateValue: value,
		record: { worker: target.workerName, kind: 'update', version, fingerprint,
			verificationPending: true, completionOnly: true },
	}, async fence => {
		await verifyAddress();
		const settings = await api.getWorkerSettings(accountId, target.workerName);
		const storage = workerStorageBindings(settings);
		if (settings.annotations?.['workers/message'] !== releaseWorkerMessage(version, fingerprint)
			|| storage?.databaseId !== databaseId || storage.bucketName !== target.r2BucketName) {
			throw new Error('The published Worker or its storage changed. Recovery stopped.');
		}
		const live = await api.verifyPublishedWorkerDeployment(workersDevOrigin(target.workerName, target.workersSubdomain!), fingerprint);
		if (live.developmentBuild && live.developmentBuild.worker !== target.workerName) throw new Error('The published development build belongs to another Worker.');
		publishedArtifacts.development = live.developmentBuild;
		const schema = { api, accountId, databaseId, artifacts: publishedArtifacts };
		if (await inspectDeploymentDatabase(schema) !== SERVER_RELEASE.schemaVersion) {
			throw new Error('The published database needs a different schema. Use its matching recovery build.');
		}
		await api.queryD1(accountId, databaseId, 'SELECT path, storage_key FROM files LIMIT 1; SELECT id FROM auth_tokens LIMIT 1;');
		const releases = (await api.queryD1(accountId, databaseId, 'SELECT revision, fingerprint FROM crate_release WHERE id = 1;')).flatMap(row => row.results ?? []);
		if (live.schemaVersion !== SERVER_RELEASE.schemaVersion || !Number.isSafeInteger(live.revision) || live.revision < 1 || live.revision > SERVER_RELEASE.revision
			|| (await Promise.all(releases.map(async saved => !canReplaceServerBuild({ revision: Number(saved.revision), fingerprint: String(saved.fingerprint),
				development: await readDeploymentBuild(schema, String(saved.fingerprint)) },
			{ revision: live.revision, fingerprint, development: live.developmentBuild })))).some(Boolean)) {
			throw new Error('The published release conflicts with the saved database release. Recovery stopped.');
		}
		await releaseUpgradeGuards(api, accountId, databaseId, fence);
		await recordDeploymentRelease(schema, fence, live.revision);
		await fence.completeVerification();
		verifiedRevision = live.revision;
	});
	target.lastKnownRevision = verifiedRevision;
	target.lastDeployedVersion = version;
	target.lastDeployedFingerprint = fingerprint;
}

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
