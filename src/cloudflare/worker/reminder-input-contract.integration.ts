/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex, sha256HexBytes } from './auth';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { buildReminderMutationBody } from '@/pwa/reminder-mutation';
import { scanReminderMarkdownFile, toReminderPayload } from './reminders-web/scan';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from './storage';
import { buildDescriptionBlock } from '@/reminders/core/markdownReminderFile';
import type { ReminderRecord } from '@/pwa/types';

beforeEach(async () => {
	vi.spyOn(console, 'info').mockImplementation(() => {});
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	await env.DB.prepare('INSERT INTO auth_tokens (id, token_hash, scope) VALUES (?, ?, ?)').bind('contract', await sha256Hex('contract'), 'vault').run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const operationId = () => createReminderOperationId(Math.floor(Date.now() / 86_400_000));
const filePath = 'Reminders/Inbox.md';
function request(path: string, body: Record<string, unknown>) {
	return worker.fetch(new Request(`https://test${path}`, { method: 'POST', headers: {
		Authorization: 'Bearer contract', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
	}, body: JSON.stringify(body) }), env);
}
function editorBody(content: string, description: string, mode: 'create' | 'edit') {
	return buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode, projects: ['Inbox'], selectedProject: null,
		draft: { content, description, project: 'Inbox', defaultProject: 'Inbox', priority: 4,
			dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false } });
}
async function seed(description = 'Original description') {
	const text = '# Inbox\n\n- [ ] Original task <!-- crate-id:original -->\n' + buildDescriptionBlock(description).join('\n') + '\n';
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, filePath, text, null);
	return toReminderPayload(scanReminderMarkdownFile(filePath, text, 'Reminders')[0]!);
}
async function update(reminder: Record<string, unknown>, patch: Record<string, unknown>) {
	return request('/reminders/update', { folderPath: 'Reminders', id: reminder.id, filePath: reminder.filePath,
		expectedRevision: reminder.revision, operationId: operationId(), ...patch });
}

it.each(['line one\nline two', 'line one\r\nline two', 'line one\tvalue\n漢字 🙂', 'x'.repeat(4096)])('round-trips accepted description through the PWA payload, Worker and Markdown: %s', async description => {
	const id = operationId();
	const response = await request('/reminders/create', { ...editorBody('New task', description, 'create'), id, operationId: id });
	expect(response.status).toBe(200);
	const saved = await response.json() as { reminder: ReminderRecord };
	expect(saved.reminder.description).toBe(description);
	const stored = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, filePath);
	expect(scanReminderMarkdownFile(filePath, stored!.content, 'Reminders')[0]!.description).toBe(description);
});

it('preserves a plugin-created multiline description when the PWA changes the title and moves the reminder', async () => {
	const description = 'Keep this line\nAnd this line';
	const before = await seed(description);
	const response = await update(before, { ...editorBody('Changed title', description, 'edit'), project: 'Other' });
	expect(response.status).toBe(200);
	const { reminder } = await response.json() as { reminder: ReminderRecord };
	expect(reminder).toMatchObject({ content: 'Changed title', description, project: 'Other' });
	const stored = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, reminder.filePath);
	expect(scanReminderMarkdownFile(reminder.filePath, stored!.content, 'Reminders')[0]!.description).toBe(description);
});

it.each([{ content: 'x'.repeat(1025) }, { content: null }, { content: 42 }, { description: {} },
	{ description: 'x'.repeat(4097) }, { description: 'bad\0text' }, { dueDate: '2099-02-31' },
	{ dueDate: [] }, { dueDatetime: '2099-02-31T09:00:00Z' }, { dueDatetime: '2099-03-01T09:00:00' },
	{ priority: 3 }, { project: 42 }, { content: '\ud800' }, { description: '\udc00' }])('rejects invalid fields without changing stored bytes or acknowledging an operation: %j', async patch => {
	const before = await seed();
	const stored = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, filePath);
	const response = await update(before, patch);
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ code: 'invalid_reminder_input' });
	expect(await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, filePath)).toEqual(stored);
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_operations').first()).toEqual({ n: 0 });
});

it.each(['', null])('distinguishes explicit clears from omitted fields: %j', async description => {
	const before = await seed();
	expect((await update(before, { description })).status).toBe(200);
	const stored = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, filePath);
	expect(stored!.content).not.toContain('crate-desc:');
});


it.for([[255], [0xe2, 0x82], [0xff, 0xfe, 65, 0], [65, 0, 66, 0]])('preserves invalid source bytes when a reminder edit is refused: %j', async invalid => {
	const before = await seed();
	const row = (await env.DB.prepare('SELECT storage_key FROM files WHERE path = ?').bind(filePath).first<{ storage_key: string }>())!;
	const original = new Uint8Array(await (await env.BUCKET.get(row.storage_key))!.arrayBuffer());
	const bytes = new Uint8Array([...original, ...invalid]);
	const hash = await sha256HexBytes(bytes);
	await env.BUCKET.put(row.storage_key, bytes);
	await env.DB.prepare('UPDATE files SET hash = ?, size = ? WHERE path = ?').bind(hash, bytes.length, filePath).run();
	const response = await update(before, { content: 'Changed' });
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: 'unsupported_markdown_encoding' });
	expect(new Uint8Array(await (await env.BUCKET.get(row.storage_key))!.arrayBuffer())).toEqual(bytes);
	expect(await env.DB.prepare('SELECT hash, storage_key FROM files WHERE path = ?').bind(filePath).first()).toEqual({ hash, storage_key: row.storage_key });
});


it('retains the UTF-8 BOM and unrelated Unicode text when editing a reminder', async () => {
	const before = await seed();
	const row = (await env.DB.prepare('SELECT storage_key FROM files WHERE path = ?').bind(filePath).first<{ storage_key: string }>())!;
	const original = await (await env.BUCKET.get(row.storage_key))!.text();
	const text = '\ufeff' + original + '\nUnrelated footer: 漢字 🙂 \ufffd\n';
	const bytes = new TextEncoder().encode(text);
	await env.BUCKET.put(row.storage_key, bytes);
	await env.DB.prepare('UPDATE files SET hash = ?, size = ? WHERE path = ?').bind(await sha256HexBytes(bytes), bytes.length, filePath).run();
	expect((await update(before, { content: 'Changed title' })).status).toBe(200);
	const saved = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, filePath);
	expect(saved!.content).toBe(text.replace('Original task', 'Changed title'));
});
