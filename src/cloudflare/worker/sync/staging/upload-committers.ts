import type { commitNewFiles } from './bulk-new-file-commit';
import type { CommitResult, StagedFileCommitInput } from '../mutations';
import type { UploadOperation } from '../upload-operations';

/** Publication may cross a Durable Object boundary, which cannot carry callbacks. */
export type UploadCommitInput = Omit<StagedFileCommitInput, 'effects'> & { effects?: never };

/** The request execution owner selects how handlers publish their staged uploads. */
export interface UploadCommitters {
	commitUpload(bucket: R2Bucket, db: D1Database, params: UploadCommitInput): Promise<CommitResult>;
	/** Several uploads in one transaction, results in order. It throws when the commit
	 * fails or is uncertain; the same operations then retry through `commitUpload`. */
	commitUploads?(bucket: R2Bucket, db: D1Database, params: Array<UploadCommitInput & { operation: UploadOperation }>): Promise<CommitResult[]>;
	commitNewFiles: typeof commitNewFiles;
}
