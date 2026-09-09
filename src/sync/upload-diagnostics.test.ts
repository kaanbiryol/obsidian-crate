import { expect, it } from 'vitest';
import { normalizeRequestDiagnostics } from './request-diagnostics';
import { MAX_UPLOAD_DIAGNOSTICS, normalizeUploadDiagnostics } from './upload-diagnostics';
import { createReminderOperationId } from '../protocol/reminder-operation';

const id = createReminderOperationId(20000), clientSession = '11111111-1111-4111-8111-111111111111';
const row = { at: '2026-09-09T12:00:00.000Z', clientSession, operationId: id, kind: 'merge', phase: 'remote-committed',
	generation: 5, pathHash: 'a'.repeat(64), uploadHash: 'b'.repeat(64), baseHash: 'c'.repeat(64) };
it('bounds durable upload traces and exports only validated fields', () => {
	const rows = normalizeUploadDiagnostics(Array.from({ length: 75 }, () => ({ ...row, path: 'private.md', content: 'private note', authorization: 'secret' })));
	expect(rows).toHaveLength(MAX_UPLOAD_DIAGNOSTICS);
	expect(rows[0]).toEqual(row);
	expect(normalizeUploadDiagnostics([{ ...row, pathHash: 'private.md' }, { ...row, operationId: 'private note' }])).toEqual([]);
});
it('links safe logical upload identities to per-request attempts without exporting arbitrary headers', () => {
	const result = normalizeRequestDiagnostics({ clientSession, uploads: [{ ...row, content: 'private' }], requests: [{
		at: row.at, operationId: clientSession, route: '/sync/upload?path=private.md', method: 'POST', status: 200, outcome: 'response',
		uploadOperationIds: [id, 'private', id], headers: { authorization: 'private' },
	}] });
	expect(result?.requests[0]?.uploadOperationIds).toEqual([id]);
	expect(result?.uploads).toEqual([row]);
	expect(JSON.stringify(result)).not.toContain('private');
});
