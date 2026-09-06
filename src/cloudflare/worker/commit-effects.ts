/** Extra statements share the file metadata transaction and must be conditional
 * on every staged key becoming the current file revision. */
export type CommitEffects = (files: Array<{ path: string; storageKey: string }>) => D1PreparedStatement[];
