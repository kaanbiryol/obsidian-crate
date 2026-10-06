import type { commitNewFiles } from './bulk-new-file-commit';
import type { commitStagedFile } from './sync-mutations';

/** The request execution owner selects how handlers publish their staged uploads. */
export interface UploadCommitters {
	commitUpload: typeof commitStagedFile;
	commitNewFiles: typeof commitNewFiles;
}
