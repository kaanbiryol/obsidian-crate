import type { DataAdapter } from 'obsidian';
import { isRecord } from '@/platform/validation';
import type { BatchMoveFile } from '../../protocol/sync-types';

const MOVE_JOURNAL_VERSION = 1;

/** Server moves this device sent but has not yet recorded in a saved manifest. A move
 * whose response was lost is resent from here before the next sync plans anything, so the
 * server answers it from its own state even after the file was renamed again. The record
 * is written before the first request and removed once the manifest is saved. */
export class MoveJournal {
	constructor(private adapter: Pick<DataAdapter, 'exists' | 'read' | 'write' | 'remove'>, private path: string, private authority?: string) {}

	/** Moves still unrecorded. A torn record was never complete, so none of it was sent. */
	async pending(): Promise<BatchMoveFile[]> {
		if (!await this.adapter.exists(this.path)) return [];
		let raw: unknown;
		try { raw = JSON.parse(await this.adapter.read(this.path)); } catch { return []; }
		return decodeMoveJournal(raw, this.authority);
	}

	async record(moves: readonly BatchMoveFile[]): Promise<void> {
		await this.adapter.write(this.path, JSON.stringify({ version: MOVE_JOURNAL_VERSION, authority: this.authority, moves }));
	}

	async clear(): Promise<void> {
		if (await this.adapter.exists(this.path)) await this.adapter.remove(this.path);
	}
}

/** Another server's moves never apply here, so they read as none. */
function decodeMoveJournal(raw: unknown, authority?: string): BatchMoveFile[] {
	if (!isRecord(raw) || raw.version !== MOVE_JOURNAL_VERSION || !Array.isArray(raw.moves)) {
		throw new Error('Unsupported move journal. Preserve the vault and its sync metadata before resetting sync.');
	}
	if (raw.authority !== authority) return [];
	return raw.moves.map((move: unknown) => {
		if (!isRecord(move) || typeof move.from !== 'string' || typeof move.to !== 'string'
			|| typeof move.expectedHash !== 'string' || typeof move.expectedRevision !== 'string') {
			throw new Error('Damaged move journal. Preserve the vault and its sync metadata before resetting sync.');
		}
		return { from: move.from, to: move.to, expectedHash: move.expectedHash, expectedRevision: move.expectedRevision };
	});
}
