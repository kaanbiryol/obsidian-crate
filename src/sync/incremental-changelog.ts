import type { ChangelogEntry } from '../protocol/sync-types';
import type { IncrementalSyncPlannerContext } from './planner-types';

/** Read one deduplicated changelog snapshot without advancing the saved cursor. */
export async function readIncrementalChangelog(
  api: Pick<IncrementalSyncPlannerContext['api'], 'getChanges'>,
  lastSeq: number,
  assertActive?: () => void,
) {
  const changesByPath = new Map<string, ChangelogEntry>();
  let changeCount = 0;
  let since = lastSeq;
  let latestSeq = since;

  while (true) {
    assertActive?.();
    const response = await api.getChanges(since);

    if (response.cursorExpired) {
      return null;
    }

    for (const entry of response.changes) changesByPath.set(entry.path, entry);
    changeCount += response.changes.length;
    latestSeq = response.lastSeq;

    if (!response.hasMore || response.changes.length === 0) {
      break;
    }

    const lastChange = response.changes[response.changes.length - 1];
    if (!lastChange) {
      break;
    }

    if (lastChange.seq <= since) throw new Error('Changelog cursor did not advance');
    since = lastChange.seq;
  }
  return { changesByPath, changeCount, latestSeq };
}
