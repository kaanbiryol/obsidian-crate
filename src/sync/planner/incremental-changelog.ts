import type { ChangelogEntry } from '../../protocol/sync-types';
import type { IncrementalSyncPlannerContext } from './types';

/** Read one deduplicated changelog snapshot without advancing the saved cursor. */
export async function readIncrementalChangelog(
  api: Pick<IncrementalSyncPlannerContext['files'], 'getChanges'>,
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

    if (!response.hasMore) {
      break;
    }

    // An encrypted page can filter out every entry; keep paging from the raw page.
    const next = response.nextSince ?? response.changes.at(-1)?.seq;
    if (next === undefined || next <= since) throw new Error('Changelog cursor did not advance');
    since = next;
  }
  return { changesByPath, changeCount, latestSeq };
}
