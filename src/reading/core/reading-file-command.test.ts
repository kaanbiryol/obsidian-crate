import { expect, it } from 'vitest';
import { sha256Hex } from '@/platform/sha256';
import { managedArticle } from './article';
import { readReadingFrontmatter } from './frontmatter';
import { createReadingNote, parseReadingNote } from './notes';
import { planReadingFileCommand, readingFileCommandRefusal } from './reading-file-command';

const ID = '7f1c2a3e-1b4d-4c5e-8f60-9a8b7c6d5e4f';
const content = createReadingNote({ id: ID, url: 'https://example.com/a', title: 'Example', savedAt: '2026-01-01T00:00:00.000Z' });
const item = parseReadingNote(content)!;
const bodyHash = () => sha256Hex(readReadingFrontmatter(content)?.body ?? '');

it('removes a note only while it is what the client showed', async () => {
	expect(await planReadingFileCommand(item, content, { action: 'delete', before: { favorite: item.favorite }, markdownHash: await bodyHash() })).toEqual({ kind: 'remove' });
	expect(await planReadingFileCommand(item, content, { action: 'delete', before: { favorite: !item.favorite }, markdownHash: await bodyHash() })).toMatchObject({ issue: 'conflict' });
	expect(await planReadingFileCommand(item, content, { action: 'delete', before: { favorite: item.favorite }, markdownHash: '0'.repeat(64) })).toMatchObject({ issue: 'conflict' });
	expect(await planReadingFileCommand(item, content, { action: 'delete', before: { title: item.title }, markdownHash: await bodyHash() })).toMatchObject({ issue: 'unsupported' });
	expect(await planReadingFileCommand(item, content, { action: 'delete', before: {}, markdownHash: await bodyHash() })).toMatchObject({ issue: 'invalid' });
});

it('writes an update whose fields still match and refuses others', async () => {
	const plan = await planReadingFileCommand(item, content, { action: 'update', before: { favorite: item.favorite }, changes: { favorite: !item.favorite } });
	expect(plan.kind).toBe('write');
	expect(plan.kind === 'write' && parseReadingNote(plan.content)?.favorite).toBe(!item.favorite);
	expect(await planReadingFileCommand(item, content, { action: 'update', before: { favorite: !item.favorite }, changes: { favorite: true } })).toMatchObject({ issue: 'conflict' });
	expect(await planReadingFileCommand(item, content, { action: 'update', before: { title: item.title }, changes: { title: 'Other' } })).toMatchObject({ issue: 'unsupported' });
	expect(await planReadingFileCommand(item, content, { action: 'update', before: {}, changes: [] })).toMatchObject({ issue: 'invalid' });
});

it('retries only a capture whose article section is still empty', async () => {
	const plan = await planReadingFileCommand(item, content, { action: 'retry' });
	expect(plan.kind === 'write' && parseReadingNote(plan.content)?.extraction_status).toBe('pending');
	const block = managedArticle(content)!;
	const filled = `${content.slice(0, block.start)}\nSaved text\n${content.slice(block.end)}`;
	expect(await planReadingFileCommand(parseReadingNote(filled)!, filled, { action: 'retry' })).toMatchObject({ issue: 'not-empty' });
});

it('words each refusal as the Worker answers it', () => {
	expect(readingFileCommandRefusal({ kind: 'issue', issue: 'invalid' }, 'update')).toEqual({ message: 'Choose a Reading change.', status: 400 });
	expect(readingFileCommandRefusal({ kind: 'issue', issue: 'invalid', message: 'Use fewer tags.' }, 'update')).toEqual({ message: 'Use fewer tags.', status: 400 });
	expect(readingFileCommandRefusal({ kind: 'issue', issue: 'unsupported' }, 'delete')).toEqual({ message: 'Unsupported Reading change.', status: 400 });
	expect(readingFileCommandRefusal({ kind: 'issue', issue: 'not-empty' }, 'retry')).toEqual({ message: 'Only URL captures with an unchanged article section can be extracted.', status: 400 });
	expect(readingFileCommandRefusal({ kind: 'issue', issue: 'conflict' }, 'delete')).toEqual({ message: 'This item changed on another device. Refresh before deleting it.', status: 409, code: 'reading_conflict' });
	expect(readingFileCommandRefusal({ kind: 'issue', issue: 'conflict' }, 'update')).toEqual({ message: 'This item changed on another device. Refresh before editing it.', status: 409, code: 'reading_conflict' });
});
