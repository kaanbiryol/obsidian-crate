import { isRecord } from '../plugin/settings';
import { isSyncDate, isSyncSequence, parseSyncFiles } from './sync-validation';
import type { FileEntry } from './sync-types';

export const SHARED_CHECKPOINT_CAPABILITY = 'shared-history-checkpoints-v1';
export const MAX_SHARED_CHECKPOINTS = 20;
export const CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CHECKPOINT_FILES = 20_000;
export const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
export const isCheckpointId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

export interface SharedCheckpoint {
    id: string;
    sequence: number;
    timestamp: string;
    expiresAt: number;
    fileCount: number;
}
export interface SharedCheckpointDocument {
    version: 1;
    checkpoint: SharedCheckpoint;
    files: Record<string, FileEntry>;
}

export function parseSharedCheckpoint(value: unknown): SharedCheckpoint {
    if (!isRecord(value) || !isCheckpointId(value.id) || !isSyncSequence(value.sequence)
        || !isSyncDate(value.timestamp) || !isSyncSequence(value.expiresAt)
        || !isSyncSequence(value.fileCount) || value.fileCount > MAX_CHECKPOINT_FILES
        || value.expiresAt <= Date.parse(value.timestamp) || value.expiresAt > Date.parse(value.timestamp) + CHECKPOINT_RETENTION_MS) {
        throw new Error('Invalid shared checkpoint metadata');
    }
    return { id: value.id, sequence: value.sequence, timestamp: value.timestamp, expiresAt: value.expiresAt, fileCount: value.fileCount };
}

export function parseSharedCheckpointList(value: unknown): SharedCheckpoint[] {
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.checkpoints) || value.checkpoints.length > MAX_SHARED_CHECKPOINTS) throw new Error('Invalid shared checkpoint list');
    const checkpoints = value.checkpoints.map(parseSharedCheckpoint);
    if (new Set(checkpoints.map(entry => entry.id)).size !== checkpoints.length) throw new Error('Duplicate shared checkpoint');
    return checkpoints;
}

export function parseSharedCheckpointDocument(value: unknown): SharedCheckpointDocument {
    if (!isRecord(value) || value.version !== 1) throw new Error('Unsupported shared checkpoint');
    const checkpoint = parseSharedCheckpoint(value.checkpoint);
    const files = parseSyncFiles(value.files);
    if (Object.keys(files).length !== checkpoint.fileCount) throw new Error('Incomplete shared checkpoint');
    return { version: 1, checkpoint, files };
}
