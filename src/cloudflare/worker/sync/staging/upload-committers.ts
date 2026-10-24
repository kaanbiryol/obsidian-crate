import type { commitNewFiles } from './bulk-new-file-commit';
import type { CommitResult, StagedFileCommitInput } from '../mutations';

/** Publication may cross a Durable Object boundary, which cannot carry callbacks. */
export type UploadCommitInput = Omit<StagedFileCommitInput, 'effects'> & { effects?: never };

/** The request execution owner selects how handlers publish their staged uploads. */
export interface UploadCommitters {
	commitUpload(bucket: R2Bucket, db: D1Database, params: UploadCommitInput): Promise<CommitResult>;
	commitNewFiles: typeof commitNewFiles;
}
