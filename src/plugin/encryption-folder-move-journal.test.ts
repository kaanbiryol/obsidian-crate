import { expect, it } from 'vitest';
import type { SecretStorageService } from './secret-storage';
import { completeFolderMoveHead, readFolderMoves, replaceFolderMoveHead, writeFolderMoves } from './encryption-folder-move-journal';

function storage() {
  const saved = new Map<string, string>();
  return { get: (key: string) => saved.get(key) || null, set: (key: string, value: string) => { saved.set(key, value); } } as SecretStorageService;
}

it('preserves moves appended after a job was read when replacing and completing its head', () => {
  const saved = storage();
  const first = { id: 'first', from: 'Reading', to: 'Articles' };
  const second = { id: 'second', from: 'Articles', to: 'Saved' };
  writeFolderMoves(saved, { version: 1, moves: [first] });
  const captured = readFolderMoves(saved).moves[0]!;
  writeFolderMoves(saved, { version: 1, moves: [first, second] });
  const updated = { ...captured, scopeChange: false };
  replaceFolderMoveHead(saved, updated);
  expect(readFolderMoves(saved).moves).toEqual([updated, second]);
  completeFolderMoveHead(saved, captured.id);
  expect(readFolderMoves(saved).moves).toEqual([second]);
});

it.each(['replace', 'complete'] as const)('rejects a stale head without changing the journal during %s', operation => {
  const saved = storage();
  const current = { id: 'current', from: 'Reading', to: 'Articles' };
  writeFolderMoves(saved, { version: 1, moves: [current] });
  expect(() => operation === 'replace'
    ? replaceFolderMoveHead(saved, { ...current, id: 'stale' })
    : completeFolderMoveHead(saved, 'stale')).toThrow('pending folder move changed');
  expect(readFolderMoves(saved).moves).toEqual([current]);
});
