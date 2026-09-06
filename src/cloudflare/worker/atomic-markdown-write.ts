import { enqueueFileProjection } from './notification-projection-queue';
import type { CommitEffects } from './commit-effects';
import { changedRows } from './db';
import { portablePathKey } from '../../protocol/portable-path';
import { stageMarkdownFile, type StagedMarkdownFile } from './markdown-file-staging';
import { FileVersionConflictError } from './storage';
import {
	collectCleanupKeys,
	deleteBucketObjectsOrQueue,
	FILE_VERSION_RETENTION_MS,
	getStoredFileRow,
} from './sync-storage';

function destinationMutation(
	db: D1Database,
	destination: StagedMarkdownFile,
	source: StagedMarkdownFile,
): D1PreparedStatement {
	if (destination.expectedHash === null) {
		return db.prepare(`/* atomic-destination-insert */
			INSERT INTO files (path, portable_path, hash, size, modified, storage_key)
			SELECT ?, ?, ?, ?, datetime('now'), ?
			WHERE NOT EXISTS (SELECT 1 FROM files WHERE path = ?)
			AND EXISTS (SELECT 1 FROM files WHERE path = ? AND hash = ?)
			ON CONFLICT(path) DO NOTHING`)
			.bind(
				destination.path,
				portablePathKey(destination.path),
				destination.hash,
				destination.size,
				destination.objectKey,
				destination.path,
				source.path,
				source.expectedHash,
			);
	}

	return db.prepare(`/* atomic-destination-update */
		UPDATE files SET portable_path = ?, hash = ?, size = ?, modified = datetime('now'), storage_key = ?
		WHERE path = ? AND hash = ?
		AND EXISTS (SELECT 1 FROM files WHERE path = ? AND hash = ?)`)
		.bind(
			portablePathKey(destination.path),
			destination.hash,
			destination.size,
			destination.objectKey,
			destination.path,
			destination.expectedHash,
			source.path,
			source.expectedHash,
		);
}

function sourceMutation(
	db: D1Database,
	source: StagedMarkdownFile,
	destination: StagedMarkdownFile,
): D1PreparedStatement {
	return db.prepare(`/* atomic-source-update */
		UPDATE files SET portable_path = ?, hash = ?, size = ?, modified = datetime('now'), storage_key = ?
		WHERE path = ? AND hash = ?
		AND EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)`)
		.bind(
			portablePathKey(source.path),
			source.hash,
			source.size,
			source.objectKey,
			source.path,
			source.expectedHash,
			destination.path,
			destination.objectKey,
		);
}

function changelogStatement(db: D1Database, staged: StagedMarkdownFile): D1PreparedStatement {
	return db.prepare(`INSERT INTO changelog (path, action, hash, size, revision)
		SELECT ?, 'put', ?, ?, ?
		WHERE EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)`)
		.bind(staged.path, staged.hash, staged.size, staged.objectKey, staged.path, staged.objectKey);
}

function retainVersionStatement(
	db: D1Database,
	previous: { path: string; hash: string; size: number; storageKey: string },
	source: StagedMarkdownFile,
	destination: StagedMarkdownFile,
): D1PreparedStatement {
	return db.prepare(`INSERT OR IGNORE INTO file_versions
		(storage_key, path, hash, size, reason, expires_at)
		SELECT ?, ?, ?, ?, 'replaced', ?
		WHERE EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)
		AND EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)`)
		.bind(
			previous.storageKey,
			previous.path,
			previous.hash,
			previous.size,
			Date.now() + FILE_VERSION_RETENTION_MS,
			source.path,
			source.objectKey,
			destination.path,
			destination.objectKey,
		);
}

export async function writeCommittedMarkdownFilePair(
	bucket: R2Bucket,
	db: D1Database,
	params: {
		source: { path: string; content: string; expectedHash: string };
		effects?: CommitEffects;
		destination: { path: string; content: string; expectedHash: string | null };
	},
): Promise<{
	source: { hash: string; size: number };
	destination: { hash: string; size: number };
}> {
	if (params.source.path === params.destination.path) {
		throw new Error('Atomic reminder move requires two distinct files');
	}

	const [previousSource, previousDestination] = await Promise.all([
		getStoredFileRow(db, params.source.path),
		getStoredFileRow(db, params.destination.path),
	]);
	const stagedFiles: StagedMarkdownFile[] = [];
	try {
		stagedFiles.push(await stageMarkdownFile(
			bucket,
			params.destination.path,
			params.destination.content,
			params.destination.expectedHash,
		));
		stagedFiles.push(await stageMarkdownFile(
			bucket,
			params.source.path,
			params.source.content,
			params.source.expectedHash,
		));
	} catch (error) {
		await deleteBucketObjectsOrQueue(bucket, db, stagedFiles.map(file => file.objectKey));
		throw error;
	}

	const [destination, source] = stagedFiles as [StagedMarkdownFile, StagedMarkdownFile];
	const previousVersions = [
		...(previousSource && collectCleanupKeys(previousSource, source.objectKey).length > 0
			? [{ path: source.path, ...previousSource }]
			: []),
		...(previousDestination && collectCleanupKeys(previousDestination, destination.objectKey).length > 0
			? [{ path: destination.path, ...previousDestination }]
			: []),
	];

	// An exception may follow a committed transaction. Never reclaim those keys
	// here; the orphan sweep checks references after the uncertainty window.
	const results: unknown[] = await db.batch([
			destinationMutation(db, destination, source),
			sourceMutation(db, source, destination),
			changelogStatement(db, destination),
			changelogStatement(db, source),
			...previousVersions.map(previous => retainVersionStatement(db, previous, source, destination)),
			...enqueueFileProjection(db, source.path, source.objectKey),
			...enqueueFileProjection(db, destination.path, destination.objectKey),
			...(params.effects?.([source, destination].map(file => ({ path: file.path, storageKey: file.objectKey }))) ?? []),
	]);

	const destinationCommitted = changedRows(results[0]) === 1;
	const sourceCommitted = changedRows(results[1]) === 1;
	if (!destinationCommitted || !sourceCommitted) {
		if (destinationCommitted !== sourceCommitted) {
			throw new Error('Atomic reminder move committed only one file');
		}
		await deleteBucketObjectsOrQueue(bucket, db, stagedFiles.map(file => file.objectKey));
		const [currentSource, currentDestination] = await Promise.all([
			getStoredFileRow(db, source.path),
			getStoredFileRow(db, destination.path),
		]);
		if (currentSource?.hash !== source.expectedHash) {
			throw new FileVersionConflictError(source.path, currentSource?.hash ?? null);
		}
		throw new FileVersionConflictError(destination.path, currentDestination?.hash ?? null);
	}

	return {
		source: { hash: source.hash, size: source.size },
		destination: { hash: destination.hash, size: destination.size },
	};
}
