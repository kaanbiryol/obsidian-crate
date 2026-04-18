import {
	getWorkerBindings,
	listD1Databases,
	listR2Buckets,
	listWorkers,
} from './api';
import type {
	CrateResources,
	DiscoverCrateResourcesInput,
} from './infrastructure-types';
import {
	collectResourcesFromWorkerBindings,
	toCredentials,
} from './infrastructure-shared';

export async function discoverCrateResources(
	input: DiscoverCrateResourcesInput
): Promise<CrateResources> {
	const credentials = toCredentials(input.accountId, input.apiToken);

	const [allBuckets, allWorkers, allDatabases] = await Promise.all([
		listR2Buckets(credentials),
		listWorkers(credentials),
		listD1Databases(credentials),
	]);

	const includeCratePrefixed = input.includeCratePrefixed !== false;

	const bucketNames = new Set<string>();
	const workerNames = new Set<string>();
	const databaseIds = new Set<string>();

	if (includeCratePrefixed) {
		for (const bucket of allBuckets) {
			if (bucket.name.startsWith('crate-')) {
				bucketNames.add(bucket.name);
			}
		}
		for (const worker of allWorkers) {
			if (worker.id.startsWith('crate-')) {
				workerNames.add(worker.id);
			}
		}
		for (const database of allDatabases) {
			if (database.name.startsWith('crate-')) {
				databaseIds.add(database.uuid);
			}
		}
	}

	if (input.bucketName) {
		bucketNames.add(input.bucketName);
	}
	if (input.workerName) {
		workerNames.add(input.workerName);
	}
	if (input.databaseId) {
		databaseIds.add(input.databaseId);
	}

	const matchedWorkers = allWorkers.filter((worker) => workerNames.has(worker.id));
	if (matchedWorkers.length > 0) {
		await Promise.all(matchedWorkers.map(async (worker) => {
			try {
				const bindings = await getWorkerBindings(credentials, worker.id);
				collectResourcesFromWorkerBindings(bindings, bucketNames, databaseIds);
			} catch {
				// Best effort. We can still proceed with known names.
			}
		}));
	}

	return {
		buckets: allBuckets.filter((bucket) => bucketNames.has(bucket.name)),
		workers: allWorkers.filter((worker) => workerNames.has(worker.id)),
		databases: allDatabases.filter((database) => databaseIds.has(database.uuid)),
	};
}
