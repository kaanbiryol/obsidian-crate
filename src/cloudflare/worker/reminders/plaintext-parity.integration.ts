/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../../schema.sql?raw';
import worker from '../index';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol/server-info';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { applyReminderFileCommand, reminderCommandPayload, ReminderCommandError, type ReminderFileCommandOptions } from '@/reminders/core/reminderFileCommand';
import { ReminderInputError } from '@/reminders/core/reminderMutationInput';
import { ReminderMarkdownContextError } from '@/reminders/core/markdownTaskContext';
import { scanReminderMarkdownContent } from '@/reminders/core/markdownScan';
import { buildCreatedReminderBlock } from '@/reminders/core/markdownReminderMutation';
import { buildDescriptionBlock } from '@/reminders/core/reminderDescription';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../storage';
import { PLAINTEXT_COMMAND_OPTIONS } from './command';
import { sha256Hex } from '@/platform/sha256';

// The plaintext Worker routes apply the shared command used by encrypted web
// apps with their released options, so their Markdown agrees. Their responses
// keep the released wire format; differences from the web app's answers are
// recorded per case.
const folderPath = 'Reminders';
const inbox = 'Reminders/Inbox.md', work = 'Reminders/Work.md', home = 'Reminders/Home.md';
const paths = [inbox, work, home];
const routes = {
	create: ['POST', '/reminders/create'],
	update: ['POST', '/reminders/update'],
	'set-completed': ['POST', '/reminders/set-completed'],
	delete: ['DELETE', '/reminders/delete'],
	reorder: ['POST', '/reminders/reorder'],
} as const;
type Action = keyof typeof routes;
type Files = Record<string, string>;
interface Outcome { status: number; body: unknown; files: Record<string, string | null> }
type Expected = { worker: Omit<Outcome, 'files'> & Partial<Outcome>; core: Omit<Outcome, 'files'> };

const timed = buildCreatedReminderBlock({ content: 'Call Sam', description: 'Ask about\nthe weekend', reminderId: 'r-timed', priority: 1,
	dueDate: new Date('2099-01-05T09:30:00.000Z'), hasTime: true });
const repeating = buildCreatedReminderBlock({ content: 'Water plants', reminderId: 'r-repeat', priority: 4,
	dueDate: new Date('2099-01-01T08:00:00.000Z'), hasTime: true, recurrence: { frequency: 'daily', timezone: 'UTC', hour: 8, minute: 0, count: 3 } });
const inboxNote = ['# Inbox', '', 'Private prose before', '',
	'- [ ] Buy bread @2099-01-02 <!-- crate-id:r-plain -->',
	timed.checkboxLine, ...buildDescriptionBlock(timed.description),
	repeating.checkboxLine,
	'- [ ] Undated task <!-- crate-id:r-undated -->',
	'- [x] Finished task <!-- crate-id:r-done -->',
	'', 'Unrelated paragraph after', ''].join('\n');
const workNote = '# Work\n\nOther project prose\n\n- [ ] Work task <!-- crate-id:r-work -->\n';
const seeded: Files = { [inbox]: inboxNote, [work]: workNote };
const oversized = (reminders: string) => `# Large\n\n${'x'.repeat(1024 * 1024)}\n\n${reminders}\n`;
const recurrence = { frequency: 'weekly', daysOfWeek: [1], timezone: 'UTC', hour: 9, minute: 0 };

const issuedDay = Math.floor(Date.now() / 86_400_000);
const operationId = () => createReminderOperationId(issuedDay);
async function edit(files: Files, id: string, patch: Record<string, unknown> = {}) {
	const filePath = paths.find(path => files[path]?.includes(`crate-id:${id} `));
	const reminder = scanReminderMarkdownContent(filePath!, files[filePath!]!, folderPath).reminders.find(item => item.id === id)!;
	return { folderPath, operationId: operationId(), id, filePath, expectedRevision: (await reminderCommandPayload(reminder)).revision, ...patch };
}
function create(patch: Record<string, unknown>, id = operationId()) {
	return { folderPath, operationId: id, id, project: 'Inbox', ...patch };
}
function reorder(files: Files, path: string, orderedIds: string[], patch: Record<string, unknown> = {}) {
	return { folderPath, operationId: operationId(), project: path.slice(folderPath.length + 1, -3), orderedIds,
		expectedOrder: files[path] ? scanReminderMarkdownContent(path, files[path], folderPath).reminders.map(item => item.id) : [], ...patch };
}

beforeEach(async () => {
	vi.spyOn(console, 'info').mockImplementation(() => {});
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	await env.DB.prepare('INSERT INTO auth_tokens (id, token_hash, scope) VALUES (?, ?, ?)').bind('parity', await sha256Hex('parity'), 'vault').run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function runWorker(action: Action, body: Record<string, unknown>, files: Files): Promise<Outcome> {
	for (const [path, content] of Object.entries(files)) await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	const [method, route] = routes[action];
	const response = await worker.fetch(new Request(`https://test${route}`, { method, body: JSON.stringify(body), headers: {
		Authorization: 'Bearer parity', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
	} }), env);
	const stored = await Promise.all(paths.map(async path => [path, (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))?.content ?? null]));
	return { status: response.status, body: await response.json() as unknown, files: Object.fromEntries(stored) as Outcome['files'] };
}

/** Mirrors how EncryptedReminderApi answers the web app from the shared command. */
async function runCore(action: Action, body: Record<string, unknown>, files: Files, options?: ReminderFileCommandOptions): Promise<Outcome> {
	const before = Object.fromEntries(paths.map(path => [path, files[path] ?? null]));
	try {
		const result = await applyReminderFileCommand(action, body, folderPath, async path => files[path] ?? null, options);
		const after = { ...before, ...Object.fromEntries(result.files.map(file => [file.path, file.content])) };
		return { status: 200, body: JSON.parse(JSON.stringify(result.response)) as unknown, files: after };
	} catch (error) {
		if (error instanceof ReminderCommandError) return { status: error.status, body: { error: error.message, code: error.code }, files: before };
		if (error instanceof ReminderInputError) return { status: 400, body: { error: error.message, code: 'invalid_reminder_input' }, files: before };
		if (error instanceof ReminderMarkdownContextError) return { status: 409, body: { error: error.message, code: 'reminder_markdown_context' }, files: before };
		return { status: 0, body: { thrown: error instanceof Error ? error.message : String(error) }, files: before };
	}
}

async function compare(action: Action, files: Files, body: Record<string, unknown>) {
	const core = await runCore(action, body, files);
	const plaintext = await runCore(action, body, files, PLAINTEXT_COMMAND_OPTIONS);
	const workerOutcome = await runWorker(action, body, files);
	expect(workerOutcome.files).toEqual(plaintext.files);
	if (workerOutcome.status === 200) expect(workerOutcome.body).toEqual(plaintext.body);
	return { core, worker: workerOutcome };
}

describe('plaintext Worker routes and the shared reminder command', () => {
	it.each<[string, Action, Files, (files: Files) => Promise<Record<string, unknown>> | Record<string, unknown>]>([
		['creates in an existing note', 'create', seeded, () => create({ content: 'New task', description: 'Line one\nLine two', priority: 1, dueDatetime: '2099-03-01T09:30:00.000Z' })],
		['creates a repeating reminder in a new note', 'create', seeded, () => create({ content: 'Standup', project: 'Home', dueDatetime: '2099-03-02T09:00:00.000Z', recurrence })],
		['updates in place', 'update', seeded, files => edit(files, 'r-plain', { content: 'Buy milk', description: 'From the shop', priority: 1, dueDate: '2099-02-03' })],
		['clears fields in place', 'update', seeded, files => edit(files, 'r-timed', { description: null, dueDate: null, dueDatetime: null, recurrence: null })],
		['edits a repeating reminder in place', 'update', seeded, files => edit(files, 'r-repeat', { recurrence: { ...recurrence, count: 5 } })],
		['moves into an existing note', 'update', seeded, files => edit(files, 'r-timed', { project: 'Work', content: 'Call Sam back' })],
		['moves into a new note while clearing fields', 'update', seeded, files => edit(files, 'r-timed', { project: 'Home', description: null, dueDate: null, dueDatetime: null })],
		['moves a repeating reminder', 'update', seeded, files => edit(files, 'r-repeat', { project: 'Work' })],
		['moves a completed reminder', 'update', seeded, files => edit(files, 'r-done', { project: 'Work' })],
		['moves and adds a repeat to an undated reminder', 'update', seeded, files => edit(files, 'r-undated', { project: 'Work', recurrence })],
		['completes a reminder', 'set-completed', seeded, files => edit(files, 'r-plain', { completed: true })],
		['advances a repeating reminder', 'set-completed', seeded, files => edit(files, 'r-repeat', { completed: true })],
		['reopens a completed reminder', 'set-completed', seeded, files => edit(files, 'r-done', { completed: false })],
		['keeps an unchanged completion', 'set-completed', seeded, files => edit(files, 'r-done', { completed: true })],
		['deletes a reminder and its description', 'delete', seeded, files => edit(files, 'r-timed')],
		['reorders active reminders', 'reorder', seeded, files => reorder(files, inbox, ['r-undated', 'r-plain', 'r-repeat', 'r-timed'])],
	])('%s identically', async (_name, action, files, body) => {
		const { core, worker: workerOutcome } = await compare(action, files, await body(files));
		expect(core.status, JSON.stringify(core.body)).toBe(200);
		expect(workerOutcome).toEqual(core);
	});

	const oversizedNote = oversized('- [ ] First <!-- crate-id:r-big-1 -->\n- [ ] Second <!-- crate-id:r-big-2 -->');
	const sizeError = 'Split reminder notes larger than 1 MiB before editing them in the web app.';
	const revisionError = 'Reminder changed on another device. Reload it and review your draft before saving';
	const reorderError = 'Reminder order changed. Refresh the project before reordering; nothing was changed.';
	const duplicateError = 'Duplicate reminder identifiers. Refresh the note before editing; nothing was changed.';
	const existingId = operationId(), hiddenId = operationId();
	it.each<[string, Action, Files, (files: Files) => Promise<Record<string, unknown>> | Record<string, unknown>, Expected]>([
		['rejects an invalid priority on create', 'create', seeded, () => create({ content: 'Task', priority: 2 }), {
			worker: { status: 400, body: { error: 'Choose a valid reminder priority.', field: 'priority', code: 'invalid_reminder_input' } },
			core: { status: 400, body: { error: 'Choose a valid reminder priority.', code: 'invalid_reminder_input' } },
		}],
		['rejects an invalid priority on update', 'update', seeded, files => edit(files, 'r-plain', { priority: 3 }), {
			worker: { status: 400, body: { error: 'Choose a valid reminder priority.', field: 'priority', code: 'invalid_reminder_input' } },
			core: { status: 400, body: { error: 'Choose a valid reminder priority.', code: 'invalid_reminder_input' } },
		}],
		['rejects an invalid repeat', 'update', seeded, files => edit(files, 'r-plain', { recurrence: { frequency: 'hourly' } }), {
			worker: { status: 400, body: { error: 'Invalid recurrence frequency' } },
			core: { status: 400, body: { error: 'Invalid recurrence frequency', code: 'invalid_reminder_input' } },
		}],
		['rejects an unsafe project on create', 'create', seeded, () => create({ content: 'Escape', project: '../Secrets' }), {
			worker: { status: 400, body: { error: 'Invalid project' } },
			core: { status: 400, body: { error: 'Enter a valid reminder project.', code: 'invalid_reminder_input' } },
		}],
		['rejects an edit in an oversized note', 'update', { [inbox]: oversizedNote }, files => edit(files, 'r-big-1', { content: 'Changed' }), {
			worker: { status: 413, body: { error: sizeError } },
			core: { status: 413, body: { error: sizeError, code: 'file_too_large' } },
		}],
		['rejects a create that grows a note past 1 MiB', 'create', { [inbox]: `# Inbox\n\n${'x'.repeat(1024 * 1024 - 32)}\n` }, () => create({ content: 'One more reminder' }), {
			worker: { status: 413, body: { error: sizeError } },
			core: { status: 413, body: { error: sizeError, code: 'file_too_large' } },
		}],
		['deletes from an oversized note only on the Worker', 'delete', { [inbox]: oversizedNote }, files => edit(files, 'r-big-1'), {
			worker: { status: 200, body: { success: true, id: 'r-big-1' }, files: { [inbox]: oversized('- [ ] Second <!-- crate-id:r-big-2 -->'), [work]: null, [home]: null } },
			core: { status: 413, body: { error: sizeError, code: 'file_too_large' } },
		}],
		['reorders an oversized note only on the Worker', 'reorder', { [inbox]: oversizedNote }, files => reorder(files, inbox, ['r-big-2', 'r-big-1']), {
			worker: { status: 200, body: { success: true }, files: { [inbox]: oversized('- [ ] Second <!-- crate-id:r-big-2 -->\n- [ ] First <!-- crate-id:r-big-1 -->'), [work]: null, [home]: null } },
			core: { status: 413, body: { error: sizeError, code: 'file_too_large' } },
		}],
		['rejects a stale revision', 'update', seeded, async files => ({ ...await edit(files, 'r-plain', { content: 'Stale' }), expectedRevision: 'a'.repeat(64) }), {
			worker: { status: 409, body: { error: revisionError, code: 'version_conflict' } },
			core: { status: 409, body: { error: `${revisionError}.`, code: 'version_conflict' } },
		}],
		['requires a revision', 'set-completed', seeded, async files => ({ ...await edit(files, 'r-plain', { completed: true }), expectedRevision: undefined }), {
			worker: { status: 428, body: { error: 'Reload the reminder before saving', code: 'revision_required' } },
			core: { status: 409, body: { error: `${revisionError}.`, code: 'version_conflict' } },
		}],
		['reports a missing reminder', 'delete', seeded, async files => ({ ...await edit(files, 'r-plain'), id: 'r-gone' }), {
			worker: { status: 404, body: { error: 'Reminder not found' } },
			core: { status: 409, body: { error: 'Reminder moved, was deleted, or has duplicate identities. Refresh before saving.', code: 'version_conflict' } },
		}],
		['refuses to create an identity already in the note', 'create', { [inbox]: `# Inbox\n\n- [ ] Task <!-- crate-id:${existingId} -->\n` }, () => create({ content: 'Task' }, existingId), {
			worker: { status: 409, body: { error: 'This reminder already exists. Reload to see its committed state.' } },
			core: { status: 409, body: { error: 'This reminder already exists. Refresh its saved state.', code: 'version_conflict' } },
		}],
		['refuses a stale project order', 'reorder', seeded, files => reorder(files, inbox, ['r-plain'], { expectedOrder: ['r-plain'] }), {
			worker: { status: 409, body: { error: 'Project order changed. Reload before reordering.' } },
			core: { status: 409, body: { error: 'Project order changed. Refresh before reordering.', code: 'version_conflict' } },
		}],
		['requires the observed project order', 'reorder', seeded, files => reorder(files, inbox, ['r-plain'], { expectedOrder: undefined }), {
			worker: { status: 428, body: { error: 'Expected project order required. Reload before reordering.' } },
			core: { status: 409, body: { error: 'Project order changed. Refresh before reordering.', code: 'version_conflict' } },
		}],
		['rejects an unreadable project order', 'reorder', seeded, files => reorder(files, inbox, ['r-plain'], { expectedOrder: [1] }), {
			worker: { status: 400, body: { error: 'Invalid expected project order.' } },
			core: { status: 409, body: { error: 'Project order changed. Refresh before reordering.', code: 'version_conflict' } },
		}],
		['refuses to reorder a completed reminder', 'reorder', seeded, files => reorder(files, inbox, ['r-done', 'r-plain']), {
			worker: { status: 409, body: { error: reorderError, code: 'reminder_order_conflict' } },
			core: { status: 409, body: { error: reorderError, code: 'reminder_markdown_context' } },
		}],
		['reports a missing project note', 'reorder', seeded, files => reorder(files, home, []), {
			worker: { status: 404, body: { error: 'Project file not found' } },
			core: { status: 404, body: { error: 'Project file not found', code: 'not_found' } },
		}],
		['refuses duplicate identities', 'update', { [inbox]: '# Inbox\n\n- [ ] One <!-- crate-id:r-dup -->\n- [ ] Two <!-- crate-id:r-dup -->\n' }, files => edit(files, 'r-dup', { content: 'Renamed' }), {
			worker: { status: 409, body: { error: duplicateError, code: 'reminder_markdown_context' } },
			core: { status: 409, body: { error: 'Reminder moved, was deleted, or has duplicate identities. Refresh before saving.', code: 'version_conflict' } },
		}],
		// Released routes wrote a second copy here; the shared command refuses it.
		['refuses to move into a note that has the reminder', 'update', { [inbox]: inboxNote, [work]: `${workNote}- [ ] Copy <!-- crate-id:r-plain -->\n` }, files => edit(files, 'r-plain', { project: 'Work' }), {
			worker: { status: 409, body: { error: duplicateError, code: 'reminder_markdown_context' } },
			core: { status: 409, body: { error: 'The destination already contains this reminder', code: 'version_conflict' } },
		}],
		['saves a title that hides the reminder only on the Worker', 'create', { [inbox]: '# Inbox\n' }, () => create({ content: '<!-- crate-id:x -->' }, hiddenId), {
			worker: { status: 200, body: { success: true }, files: { [inbox]: `# Inbox\n\n- [ ] <!-- crate-id:${hiddenId} -->\n`, [work]: null, [home]: null } },
			core: { status: 0, body: { thrown: 'The edited reminder could not be verified' } },
		}],
	])('%s with known wire differences', async (_name, action, files, body, expected) => {
		const { core, worker: workerOutcome } = await compare(action, files, await body(files));
		expect({ status: workerOutcome.status, body: workerOutcome.body }).toEqual({ status: expected.worker.status, body: expected.worker.body });
		if (expected.worker.files) expect(workerOutcome.files).toEqual(expected.worker.files);
		expect({ status: core.status, body: core.body }).toEqual(expected.core);
		if (core.status !== 200) expect(core.files).toEqual(Object.fromEntries(paths.map(path => [path, files[path] ?? null])));
		if (workerOutcome.status !== 200) expect(workerOutcome.files).toEqual(core.files);
	});
});
