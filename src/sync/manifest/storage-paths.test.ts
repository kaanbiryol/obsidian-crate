import { expect, it } from 'vitest';
import { previousCheckpointCopy, RETIRED_UPLOAD_BACKUP, retiredUploadPath, syncStoragePaths } from './storage-paths';

it('recognizes the retired upload backups that connection changes write', () => {
	const operation = 'e1_20260501_00000000-0000-4000-8000-000000000001';
	const recovery = '00000000-0000-4000-8000-000000000002';
	const backup = previousCheckpointCopy(retiredUploadPath('.obsidian/plugins/crate', `${operation}.json`), recovery);
	expect(RETIRED_UPLOAD_BACKUP.exec(backup.split('/').at(-1)!)?.[1]).toBe(operation);
	expect(RETIRED_UPLOAD_BACKUP.test(previousCheckpointCopy(syncStoragePaths('dir').manifest, recovery).split('/').at(-1)!)).toBe(false);
});
