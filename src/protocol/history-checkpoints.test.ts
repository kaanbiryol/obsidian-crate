import { expect, it } from 'vitest';
import { parseSharedCheckpointDocument, parseSharedCheckpointList } from './history-checkpoints';
const checkpoint = { id: '12345678-1234-1234-1234-123456789012', sequence: 5, timestamp: '2026-09-20T10:00:00Z', expiresAt: Date.parse('2026-10-20T10:00:00Z'), fileCount: 1 };
const file = { hash: 'a'.repeat(64), size: 1, revision: 'managed/file', modified: '2026-09-20' };
it('validates full checkpoint inventories including prototype-like paths', () => {
    const document = parseSharedCheckpointDocument({ version: 1, checkpoint, files: { ['__proto__']: file } });
    expect(Object.keys(document.files)).toEqual(['__proto__']);
});
it('rejects incomplete inventories, missing revisions and unsafe paths', () => {
    expect(() => parseSharedCheckpointDocument({ version: 1, checkpoint, files: {} })).toThrow('Incomplete');
    expect(() => parseSharedCheckpointDocument({ version: 1, checkpoint, files: { 'note.md': { ...file, revision: undefined } } })).toThrow();
    expect(() => parseSharedCheckpointDocument({ version: 1, checkpoint, files: { '../secret': file } })).toThrow();
});
it('rejects duplicate IDs and invalid expiry', () => {
    expect(() => parseSharedCheckpointList({ version: 1, checkpoints: [checkpoint, checkpoint] })).toThrow('Duplicate');
    expect(() => parseSharedCheckpointList({ version: 1, checkpoints: [{ ...checkpoint, expiresAt: Date.parse('2027-01-01') }] })).toThrow();
});
