import type { CloudflareApiClient, CloudflareWorkerSettings } from './cloudflare-api';
import type { CloudflareDeploymentMetadata } from './deployment-types';

// Current and prerelease Crate tables. Unknown tables block deletion, including
// when somebody has repurposed a database which still has a Crate resource name.
const CRATE_TABLES = new Set([
	'crate_schema', 'd1_migrations', '_crate_migrations', 'changelog', 'files', 'auth_tokens',
	'scheduled_reminders', 'notification_jobs', 'vapid_keys', 'push_subscriptions',
	'push_enrollment_tokens', 'web_enrollment_tokens', 'object_cleanup_queue',
	'file_versions', 'file_deletion_receipts', 'maintenance_state', 'reminder_file_cache', 'reminder_operations',
	'reminder_identities', 'notification_policy', 'notification_projection_jobs',
	'reminder_projections', 'reminder_sources', 'reminder_occurrences', 'request_rate_limits',
]);

export type ResetApi = Pick<CloudflareApiClient,
	'getWorkerSettings' | 'listWorkers' | 'getD1Database' | 'queryD1' | 'deleteD1Database'
	| 'listDurableObjectNamespaces' | 'getR2Bucket' | 'listR2Objects' | 'deleteR2Object' | 'deleteR2Bucket' | 'retireCrateWorker'>;

export function assertWorkerTarget(settings: CloudflareWorkerSettings, metadata: CloudflareDeploymentMetadata, retired = false): void {
	const bindings = settings.bindings ?? [];
	const databases = bindings.filter(binding => binding.type === 'd1');
	const buckets = bindings.filter(binding => binding.type === 'r2_bucket');
	if (
		!settings.annotations?.['workers/message']?.startsWith('Crate ')
		&& settings.annotations?.['workers/tag'] !== 'crate'
	) throw new Error('Reset blocked: the selected Worker is not identified as Crate.');
	if (bindings.length !== (retired ? 2 : 3) || databases.length !== 1 || databases[0]?.name !== 'DB' || databases[0]?.id !== metadata.d1DatabaseId
		|| buckets.length !== 1 || buckets[0]?.name !== 'BUCKET' || buckets[0]?.bucket_name !== metadata.r2BucketName
		|| (!retired && !bindings.some(binding => binding.type === 'durable_object_namespace'
			&& binding.name === 'REMINDER_ALARMS' && binding.class_name === 'ReminderAlarm'
			&& (!binding.script_name || binding.script_name === metadata.workerName)
			&& /^[a-f0-9]{32}$/i.test(binding.namespace_id ?? '')))) {
		throw new Error('Reset blocked: the live server bindings do not match this vault’s Crate deployment.');
	}
}


export async function readCrateTables(api: ResetApi, accountId: string, databaseId: string): Promise<string[]> {
	const tables = (await api.queryD1(accountId, databaseId,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV', '_cf_METADATA');"))
		.flatMap(result => result.results ?? []).map(row => row.name);
	if (tables.some(table => typeof table !== 'string')) {
		throw new Error('Reset blocked: Cloudflare returned an invalid table listing.');
	}
	const missing = ['files', 'auth_tokens'].filter(table => !tables.includes(table));
	const unknown = (tables as string[]).filter(table => !CRATE_TABLES.has(table)).sort();
	if (missing.length || unknown.length) {
		const reasons = [
			...(missing.length ? [`Missing required Crate tables: ${missing.join(', ')}.`] : []),
			...(unknown.length ? [`Unrecognized tables: ${unknown.map(name => JSON.stringify(name)).join(', ')}.`] : []),
		];
		throw new Error(`Reset blocked: the database contains an unrecognized schema or non-Crate tables. ${reasons.join(' ')} No remote data was deleted.`);
	}
	return tables as string[];
}

export async function assertUnsharedResources(api: ResetApi, metadata: CloudflareDeploymentMetadata, namespaceId: string): Promise<void> {
	const accountId = metadata.accountId!;
	const workers = await api.listWorkers(accountId);
	if (!workers.some(script => script.id === metadata.workerName) || workers.some(script => !script.id)) {
		throw new Error('Reset blocked: could not verify the account’s Worker list.');
	}
	for (const script of workers) {
		if (script.id === metadata.workerName) continue;
		const settings = await api.getWorkerSettings(accountId, script.id!);
		if (!Array.isArray(settings.bindings)) throw new Error('Reset blocked: could not inspect another Worker’s bindings.');
		if (settings.bindings.some(binding =>
			(binding.type === 'd1' && binding.id === metadata.d1DatabaseId)
			|| (binding.type === 'r2_bucket' && binding.bucket_name === metadata.r2BucketName)
			|| (binding.type === 'durable_object_namespace' && (binding.namespace_id === namespaceId || binding.script_name === metadata.workerName))
			|| (binding.type === 'service' && binding.service === metadata.workerName))) {
			throw new Error('Reset blocked: another Worker uses this Crate deployment’s resources.');
		}
	}
}

export async function assertOwnedNamespace(api: ResetApi, accountId: string, workerName: string, namespaceId: string, retired: boolean): Promise<void> {
	const namespaces = await api.listDurableObjectNamespaces(accountId);
	if (namespaces.some(namespace => !namespace.id || !namespace.script || !namespace.class)) {
		throw new Error('Reset blocked: could not verify Durable Object ownership.');
	}
	const owned = namespaces.filter(namespace => namespace.script === workerName || namespace.id === namespaceId);
	if (retired ? owned.length !== 0 : owned.length !== 1 || owned[0]?.id !== namespaceId
		|| owned[0]?.script !== workerName || owned[0]?.class !== 'ReminderAlarm') {
		throw new Error('Reset blocked: unexpected Durable Object namespaces belong to this Worker, or reminder state has not been removed.');
	}
}
