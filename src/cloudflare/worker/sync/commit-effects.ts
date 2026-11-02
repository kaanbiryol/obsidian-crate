/** Extra statements share the file metadata transaction and must be conditional
 * on every staged key becoming the current file revision. A `null` key is a deleted path. */
export type CommitEffects = (files: Array<{ path: string; storageKey: string | null }>) => D1PreparedStatement[];
