import { expectTypeOf, it } from 'vitest';
import type { CommitEffects } from '../../commit-effects';
import type { commitStagedFile, StagedFileCommitInput } from '../mutations';
import type { UploadCommitInput, UploadCommitters } from './upload-committers';

it('allows direct publication while excluding callback-bearing inputs from transport', () => {
	expectTypeOf<typeof commitStagedFile>().toExtend<UploadCommitters['commitUpload']>();
	expectTypeOf<Omit<StagedFileCommitInput, 'effects'>>().toExtend<UploadCommitInput>();
	// Check variables with extra fields as well as fresh object literals.
	expectTypeOf<StagedFileCommitInput & { effects: CommitEffects }>().not.toExtend<UploadCommitInput>();
});
