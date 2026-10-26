/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { reminderRevision } from '@/reminders/core/reminderRevision';
import { applySchema } from '../test-support/schema-test-harness';
import { handleUpdateReminder } from './routes/existing-reminder';
import { scanReminderMarkdownFile } from './scan';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../storage';

const { DB: db, BUCKET: bucket } = env;
const sourcePath = 'Reminders/Inbox.md';
const destinationPath = 'Reminders/Personal.md';

beforeEach(async () => {
	await applySchema(db);
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function prepareMove(completed: boolean, destinationExists = false) {
	const content = `# Inbox\n\n- [${completed ? 'x' : ' '}] Keep task Jan 1, 2026 <!-- crate-id:r-keep -->\n`;
	await writeCommittedMarkdownFile(bucket, db, sourcePath, content, null);
	if (destinationExists) await writeCommittedMarkdownFile(bucket, db, destinationPath,
		'# Personal\n\n- [ ] Existing task <!-- crate-id:r-existing -->\n', null);
	const source = (await readCommittedMarkdownFileVersion(bucket, db, sourcePath))!;
	const destination = await readCommittedMarkdownFileVersion(bucket, db, destinationPath);
	const [reminder] = scanReminderMarkdownFile(sourcePath, content, 'Reminders');
	const operationId = createReminderOperationId(Math.floor(Date.now() / 86_400_000));
	const request = new Request('https://worker.test/reminders/update', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ folderPath: 'Reminders', id: reminder!.id, filePath: sourcePath,
			project: 'Personal', operationId, expectedRevision: await reminderRevision(reminder!) }),
	});
	const { seq } = (await db.prepare('SELECT MAX(seq) AS seq FROM changelog').first<{ seq: number }>())!;
	return { source, destination, request, operationId, seq };
}

async function changesSince(seq: number) {
	return (await db.prepare('SELECT path FROM changelog WHERE seq > ? ORDER BY seq').bind(seq).all<{ path: string }>()).results;
}

describe('reminder moves with D1 and R2', () => {
	it.each([false, true])('moves completed reminders into a destination that exists=%s', async destinationExists => {
		const move = await prepareMove(true, destinationExists);
		const response = await handleUpdateReminder(move.request, env);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await changesSince(move.seq)).toEqual([{ path: destinationPath }, { path: sourcePath }]);
		const source = (await readCommittedMarkdownFileVersion(bucket, db, sourcePath))!;
		const destination = (await readCommittedMarkdownFileVersion(bucket, db, destinationPath))!;
		expect(source.content).not.toContain('Keep task');
		expect(destination.content).toContain('- [x] Keep task Jan 1, 2026 <!-- crate-id:r-keep -->');
		if (destinationExists) expect(destination.content).toContain('- [ ] Existing task <!-- crate-id:r-existing -->');
		expect(await db.prepare('SELECT operation_id FROM reminder_operations WHERE operation_id = ?').bind(move.operationId).first())
			.toEqual({ operation_id: move.operationId });
	});

	it.each([false, true])('preserves a concurrent source edit and destination that exists=%s when source CAS fails', async destinationExists => {
		const move = await prepareMove(false, destinationExists);
		const concurrentContent = `${move.source.content}\nWritten concurrently in Obsidian.\n`;
		const batch = db.batch.bind(db);
		vi.spyOn(db, 'batch').mockImplementationOnce(async statements => {
			// Publish through the real writer after the move reads its source,
			// immediately before D1 evaluates the move's atomic preconditions.
			await writeCommittedMarkdownFile(bucket, db, sourcePath, concurrentContent, move.source.hash);
			return batch(statements);
		});
		await expect(handleUpdateReminder(move.request, env)).rejects.toMatchObject({ path: sourcePath });
		expect((await readCommittedMarkdownFileVersion(bucket, db, sourcePath))?.content).toBe(concurrentContent);
		expect(await readCommittedMarkdownFileVersion(bucket, db, destinationPath)).toEqual(move.destination);
		expect(await changesSince(move.seq)).toEqual([{ path: sourcePath }]);
		expect(await db.prepare('SELECT operation_id FROM reminder_operations WHERE operation_id = ?').bind(move.operationId).first()).toBeNull();
	});

	it('keeps the source reminder when the destination R2 write fails', async () => {
		const move = await prepareMove(false);
		const put = vi.spyOn(bucket, 'put').mockRejectedValueOnce(new Error('forced put failure'));
		await expect(handleUpdateReminder(move.request, env)).rejects.toThrow('forced put failure');
		expect(put).toHaveBeenCalledTimes(1);
		expect(new TextDecoder().decode(put.mock.calls[0]![1] as Uint8Array)).toContain('# Personal');
		expect(await readCommittedMarkdownFileVersion(bucket, db, sourcePath)).toEqual(move.source);
		expect(await readCommittedMarkdownFileVersion(bucket, db, destinationPath)).toBeNull();
		expect(await changesSince(move.seq)).toEqual([]);
		expect(await db.prepare('SELECT operation_id FROM reminder_operations WHERE operation_id = ?').bind(move.operationId).first()).toBeNull();
	});
});
