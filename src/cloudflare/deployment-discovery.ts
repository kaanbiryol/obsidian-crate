import type { CloudflareDeploymentMetadata } from './deployment-types';
import type {
	CloudflareAccount,
	CloudflareApiClient,
	CloudflareWorkerBinding,
	CloudflareWorkerScript,
	CloudflareWorkerSettings,
} from './cloudflare-api';

const CRATE_RESOURCE_NAME = /^crate-([a-f0-9]{16})$/;

export interface DiscoveredCloudflareDeployment {
	metadata: CloudflareDeploymentMetadata;
	modifiedOn: string | null;
}

function findBinding(
	settings: CloudflareWorkerSettings,
	type: string,
	name: string,
): CloudflareWorkerBinding | null {
	return settings.bindings?.find(binding => binding.type === type && binding.name === name) ?? null;
}

function deployedArtifact(settings: CloudflareWorkerSettings): {
	version: string | null;
	fingerprint: string | null;
} {
	const message = settings.annotations?.['workers/message']?.trim() ?? '';
	if (message.startsWith('Crate ')) {
		const [version, fingerprint] = message.slice('Crate '.length).trim().split(/\s+/, 2);
		return {
			version: version || null,
			fingerprint: fingerprint && /^[a-f0-9]{64}$/i.test(fingerprint)
				? fingerprint.toLowerCase()
				: null,
		};
	}
	const tag = settings.annotations?.['workers/tag']?.trim() ?? '';
	return {
		version: tag && tag !== 'crate' ? tag : null,
		fingerprint: null,
	};
}

function toDeployment(
	account: CloudflareAccount,
	worker: CloudflareWorkerScript,
	settings: CloudflareWorkerSettings,
): DiscoveredCloudflareDeployment | null {
	const workerName = worker.id?.trim().toLowerCase() ?? '';
	const nameMatch = CRATE_RESOURCE_NAME.exec(workerName);
	if (!nameMatch) return null;
	const deploymentId = nameMatch[1];
	if (!deploymentId) return null;

	const d1Binding = findBinding(settings, 'd1', 'DB');
	const r2Binding = findBinding(settings, 'r2_bucket', 'BUCKET');
	const reminderBinding = findBinding(settings, 'durable_object_namespace', 'REMINDER_ALARMS');
	const message = settings.annotations?.['workers/message']?.trim() ?? '';
	const tag = settings.annotations?.['workers/tag']?.trim() ?? '';
	const deployed = deployedArtifact(settings);
	if (
		!d1Binding?.id
		|| !r2Binding?.bucket_name
		|| reminderBinding?.class_name !== 'ReminderAlarm'
		|| (!message.startsWith('Crate ') && tag !== 'crate')
	) return null;

	return {
		metadata: {
			deploymentId,
			accountId: account.id,
			accountName: account.name,
			workerName,
			d1DatabaseName: workerName,
			d1DatabaseId: d1Binding.id,
			r2BucketName: r2Binding.bucket_name,
			workersSubdomain: null,
			lastDeployedVersion: deployed.version,
			lastDeployedFingerprint: deployed.fingerprint,
		},
		modifiedOn: worker.modified_on ?? null,
	};
}

export async function discoverCloudflareDeployments(
	api: Pick<CloudflareApiClient, 'getWorkerSettings' | 'listWorkers'>,
	account: CloudflareAccount,
): Promise<DiscoveredCloudflareDeployment[]> {
	const workers = (await api.listWorkers(account.id))
		.filter(worker => CRATE_RESOURCE_NAME.test(worker.id?.trim().toLowerCase() ?? ''));
	const discoveries = await Promise.all(workers.map(async (worker) => {
		if (!worker.id) return null;
		return toDeployment(account, worker, await api.getWorkerSettings(account.id, worker.id));
	}));
	return discoveries
		.filter((deployment): deployment is DiscoveredCloudflareDeployment => deployment !== null)
		.sort((left, right) => (right.modifiedOn ?? '').localeCompare(left.modifiedOn ?? ''));
}
