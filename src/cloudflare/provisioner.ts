import type { CloudflareDeploymentMetadata } from '../plugin/types';
import { CloudflareApiClient, CloudflareApiError } from './cloudflare-api';
import type { CloudflareDeploymentArtifacts } from './deployment-artifacts';
import { randomHex } from './pkce';
import { CLOUDFLARE_MAINTENANCE_CRON } from './maintenance-schedule';

const INITIAL_MIGRATION_NAME = '0001_initial.sql';
const LAUNCH_HARDENING_MIGRATION_NAME = '0002_launch_hardening.sql';
const CREATE_MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS d1_migrations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
const FIND_FILES_TABLE_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files';";
const INSPECT_LAUNCH_HARDENING_SQL = `PRAGMA table_info(files);
PRAGMA table_info(push_subscriptions);
SELECT name FROM sqlite_master
	WHERE type = 'table'
		AND name IN ('notification_jobs', 'file_versions', 'maintenance_state');`;

async function ensureD1Database(
	api: CloudflareApiClient,
	accountId: string,
	metadata: CloudflareDeploymentMetadata,
): Promise<string> {
	if (metadata.d1DatabaseId) {
		const existingById = await api.getD1Database(accountId, metadata.d1DatabaseId);
		if (existingById?.uuid) return existingById.uuid;
	}

	const existingByName = await api.findD1Database(accountId, metadata.d1DatabaseName);
	if (existingByName?.uuid) return existingByName.uuid;
	const created = await api.createD1Database(accountId, metadata.d1DatabaseName);
	if (!created.uuid) throw new Error('Cloudflare did not return the new D1 database ID');
	return created.uuid;
}

async function ensureR2Bucket(
	api: CloudflareApiClient,
	accountId: string,
	bucketName: string,
): Promise<void> {
	try {
		if (await api.getR2Bucket(accountId, bucketName)) return;
		await api.createR2Bucket(accountId, bucketName);
	} catch (error) {
		if (error instanceof CloudflareApiError && error.code === 10042) {
			throw new Error(
				'R2 is not active for this Cloudflare account. Enable an R2 subscription in the Cloudflare dashboard, then select Connect with Cloudflare again.',
			);
		}
		throw error;
	}
}

async function initializeD1Schema(input: {
	api: CloudflareApiClient;
	accountId: string;
	databaseId: string;
	artifacts: CloudflareDeploymentArtifacts;
}): Promise<void> {
	await input.api.queryD1(
		input.accountId,
		input.databaseId,
		CREATE_MIGRATIONS_TABLE_SQL,
	);

	const filesTableResults = await input.api.queryD1(
		input.accountId,
		input.databaseId,
		FIND_FILES_TABLE_SQL,
	);
	const hasFilesTable = filesTableResults.some(result =>
		(result.results ?? []).some(row => row.name === 'files'),
	);

	if (!hasFilesTable) {
		await input.api.queryD1(
			input.accountId,
			input.databaseId,
			input.artifacts.d1Schema,
		);
		if (input.artifacts.d1Migrations.length > 0) {
			const statements = input.artifacts.d1Migrations
				.map(migration => `INSERT OR IGNORE INTO d1_migrations (name) VALUES ('${migration.name}');`)
				.join('\n');
			await input.api.queryD1(input.accountId, input.databaseId, statements);
		}
		return;
	}

	await input.api.queryD1(
		input.accountId,
		input.databaseId,
		`INSERT OR IGNORE INTO d1_migrations (name) VALUES ('${INITIAL_MIGRATION_NAME}');`,
	);
	const appliedResults = await input.api.queryD1(
		input.accountId,
		input.databaseId,
		'SELECT name FROM d1_migrations ORDER BY id;',
	);
	const appliedNames = new Set(
		appliedResults
			.flatMap(result => result.results ?? [])
			.map(row => row.name)
			.filter((name): name is string => typeof name === 'string'),
	);

	for (const migration of input.artifacts.d1Migrations) {
		if (appliedNames.has(migration.name)) continue;
		if (migration.name === LAUNCH_HARDENING_MIGRATION_NAME) {
			const schemaResults = await input.api.queryD1(
				input.accountId,
				input.databaseId,
				INSPECT_LAUNCH_HARDENING_SQL,
			);
			const schemaNames = new Set(
				schemaResults
					.flatMap(result => result.results ?? [])
					.map(row => row.name)
					.filter((name): name is string => typeof name === 'string'),
			);
			const launchHardeningAlreadyApplied = [
				'portable_path',
				'disabled_at',
				'last_error',
				'notification_jobs',
				'file_versions',
				'maintenance_state',
			].every(name => schemaNames.has(name));
			if (launchHardeningAlreadyApplied) {
				await input.api.queryD1(
					input.accountId,
					input.databaseId,
					`INSERT INTO d1_migrations (name) VALUES ('${migration.name}');`,
				);
				continue;
			}
		}
		await input.api.queryD1(
			input.accountId,
			input.databaseId,
			`${migration.sql.trim()}\nINSERT INTO d1_migrations (name) VALUES ('${migration.name}');`,
		);
	}

	await input.api.queryD1(
		input.accountId,
		input.databaseId,
		input.artifacts.d1Schema,
	);
}

async function ensureWorkersSubdomain(
	api: CloudflareApiClient,
	accountId: string,
	metadata: CloudflareDeploymentMetadata,
): Promise<string> {
	const existing = await api.getWorkersSubdomain(accountId);
	if (existing) return existing;

	const candidates = [
		metadata.workersSubdomain,
		`crate-${metadata.deploymentId}`,
		`crate-${metadata.deploymentId}-${randomHex(2)}`,
	].filter((value): value is string => Boolean(value));
	let lastError: unknown = null;
	for (const candidate of candidates) {
		try {
			return await api.createWorkersSubdomain(accountId, candidate);
		} catch (error) {
			lastError = error;
		}
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error('Cloudflare could not create a workers.dev subdomain');
}

export async function provisionCloudflareDeployment(input: {
	api: CloudflareApiClient;
	accountId: string;
	metadata: CloudflareDeploymentMetadata;
	artifacts: CloudflareDeploymentArtifacts;
	onMetadataChanged: () => Promise<void>;
}): Promise<string> {
	const databaseId = await ensureD1Database(input.api, input.accountId, input.metadata);
	if (input.metadata.d1DatabaseId !== databaseId) {
		input.metadata.d1DatabaseId = databaseId;
		await input.onMetadataChanged();
	}

	await ensureR2Bucket(input.api, input.accountId, input.metadata.r2BucketName);
	await initializeD1Schema({
		api: input.api,
		accountId: input.accountId,
		databaseId,
		artifacts: input.artifacts,
	});
	await input.api.uploadWorker({
		accountId: input.accountId,
		workerName: input.metadata.workerName,
		artifacts: input.artifacts,
		d1DatabaseId: databaseId,
		r2BucketName: input.metadata.r2BucketName,
	});
	await input.api.updateWorkerSchedules(
		input.accountId,
		input.metadata.workerName,
		[CLOUDFLARE_MAINTENANCE_CRON],
	);

	const workersSubdomain = await ensureWorkersSubdomain(input.api, input.accountId, input.metadata);
	if (input.metadata.workersSubdomain !== workersSubdomain) {
		input.metadata.workersSubdomain = workersSubdomain;
		await input.onMetadataChanged();
	}
	await input.api.enableWorkerSubdomain(input.accountId, input.metadata.workerName);

	if (
		input.metadata.lastDeployedVersion !== input.artifacts.version
		|| input.metadata.lastDeployedFingerprint !== input.artifacts.fingerprint
	) {
		input.metadata.lastDeployedVersion = input.artifacts.version;
		input.metadata.lastDeployedFingerprint = input.artifacts.fingerprint;
		await input.onMetadataChanged();
	}
	return `https://${input.metadata.workerName}.${workersSubdomain}.workers.dev`;
}
