import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../../protocol/sync-types';
import { createPathRecord } from '../../protocol/path-record';
import type { FileDiff } from '../types';
import { classifyPath, classifyPaths } from './reconciliation';

// A small hash and revision alphabet makes equal and unequal states both common.
const hash = fc.constantFrom('h0', 'h1', 'h2', 'h3');
const revision = fc.option(fc.constantFrom('r0', 'r1', 'r2'), { nil: undefined });
// Names inherited from Object.prototype must never be mistaken for files.
const path = fc.oneof(fc.constantFrom('note.md', 'a/b.md', '__proto__', 'constructor', 'toString', 'Note.md'),
	fc.string({ minLength: 1, maxLength: 12 }));
const fileEntry = fc.record({ hash, revision }).map(({ hash, revision }): FileEntry => ({
	hash, size: hash.length, modified: '2026-01-01T00:00:00.000Z', ...(revision ? { revision } : {}),
}));
const side = fc.option(fileEntry, { nil: undefined });
const pathState = fc.record({ local: side, remote: side, base: side });
const vaultState = fc.uniqueArray(fc.tuple(path, pathState), { selector: ([name]) => name, maxLength: 12 });

type PathState = { local?: FileEntry; remote?: FileEntry; base?: FileEntry };
type Side = keyof PathState;

function records(states: ReadonlyArray<readonly [string, PathState]>, plain = false) {
	const make = (key: Side) => {
		const entries = states.flatMap(([name, state]) => state[key] ? [[name, state[key]] as const] : []);
		// Object.fromEntries defines own properties, so `__proto__` stays an ordinary key.
		return plain ? Object.fromEntries(entries) : createPathRecord(Object.fromEntries(entries));
	};
	return { local: make('local'), remote: make('remote'), base: make('base') };
}

function plan(states: ReadonlyArray<readonly [string, PathState]>, plain = false): FileDiff[] {
	const { local, remote, base } = records(states, plain);
	return classifyPaths(local, remote, base).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

let nextRevision = 0;

/** A minimal executor: each action does what the engine does once its guard holds. */
function apply(state: PathState, decision: FileDiff | null): PathState {
	if (!decision) {
		return state.local && state.remote ? { ...state, base: { ...state.local, revision: state.remote.revision } } : {};
	}
	switch (decision.action) {
		case 'upload': {
			const remote = { ...state.local!, revision: `server-${nextRevision++}` };
			return { local: state.local, remote, base: remote };
		}
		case 'download':
		case 'conflict':
			// A conflict preserves the local bytes in a copy, then takes the remote version.
			return { local: { ...state.remote! }, remote: state.remote, base: state.remote };
		case 'delete':
		case 'delete-local':
			return {};
	}
}

describe('three-way reconciliation invariants', () => {
	it('is deterministic and independent of record insertion order or prototype', () => {
		fc.assert(fc.property(vaultState, (states) => {
			const expected = plan(states);
			expect(plan(states)).toEqual(expected);
			expect(plan([...states].reverse())).toEqual(expected);
			expect(plan(states, true)).toEqual(expected);
			const known = new Set(states.filter(([, state]) => state.local || state.remote || state.base).map(([name]) => name));
			for (const diff of expected) expect(known.has(diff.path)).toBe(true);
		}), { numRuns: 300 });
	});

	it('matches the per-path policy for every path', () => {
		fc.assert(fc.property(vaultState, (states) => {
			const byPath = new Map(plan(states).map(diff => [diff.path, diff]));
			for (const [name, state] of states) {
				expect(byPath.get(name) ?? null).toEqual(classifyPath(name, state.local, state.remote, state.base));
			}
		}), { numRuns: 200 });
	});

	it('deletes a remote file only when the local copy is absent and the remote is the exact acknowledged baseline', () => {
		fc.assert(fc.property(path, pathState, (name, { local, remote, base }) => {
			const decision = classifyPath(name, local, remote, base);
			if (decision?.action !== 'delete') return;
			expect(local).toBeUndefined();
			expect(base?.revision).toBeDefined();
			expect(remote?.hash).toBe(base!.hash);
			expect(remote?.revision).toBe(base!.revision);
			expect(decision.remoteHash).toBe(remote!.hash);
			expect(decision.remoteRevision).toBe(remote!.revision);
		}), { numRuns: 500 });
	});

	it('deletes a local file only when the remote is absent and the local copy is the synced baseline', () => {
		fc.assert(fc.property(path, pathState, (name, { local, remote, base }) => {
			const decision = classifyPath(name, local, remote, base);
			if (decision?.action !== 'delete-local') return;
			expect(remote).toBeUndefined();
			expect(base).toBeDefined();
			expect(local?.hash).toBe(base!.hash);
			expect(decision.localHash).toBe(local!.hash);
		}), { numRuns: 500 });
	});

	it('never discards an unsynced local edit or an unseen remote edit', () => {
		fc.assert(fc.property(path, pathState, (name, { local, remote, base }) => {
			const decision = classifyPath(name, local, remote, base);
			const localEdited = local && (!base || local.hash !== base.hash);
			if (localEdited && local.hash !== remote?.hash) {
				expect(['upload', 'conflict']).toContain(decision?.action);
			}
			const remoteEdited = remote && (!base || remote.hash !== base.hash || !base.revision || remote.revision !== base.revision);
			if (!local && remoteEdited) expect(decision?.action).toBe('download');
			if (decision?.action === 'download' && local) expect(decision.localHash).toBe(local.hash);
			if (decision?.action === 'conflict') {
				expect(decision.localHash).toBe(local?.hash);
				expect(decision.remoteHash).toBe(remote?.hash);
			}
		}), { numRuns: 500 });
	});

	it('converges after one applied plan, and re-planning finds nothing to do', () => {
		fc.assert(fc.property(path, pathState, (name, state) => {
			const decision = classifyPath(name, state.local, state.remote, state.base);
			const next = apply(state, decision);
			expect(next.local?.hash).toBe(next.remote?.hash);
			expect(classifyPath(name, next.local, next.remote, next.base)).toBeNull();
			const again = apply(next, null);
			expect(classifyPath(name, again.local, again.remote, again.base)).toBeNull();
		}), { numRuns: 500 });
	});
});
