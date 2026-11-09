/// <reference types="@cloudflare/vitest-plugin/types" />
import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applySchema } from '../test-support/schema-test-harness';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { createReadingNote } from '@/reading/core/notes';
import { patchReadingFrontmatter } from '@/reading/core/frontmatter';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { readingIndexScope } from './library-index';
import { mutateReading } from './mutations';
import { meterD1Usage } from '../d1/d1-usage';

const policy = { enabled: 1, folder_path: 'Reading', generation: 'g', revision: 'r' };
// Every web app edit is a synced file edit: a version, changelog, receipt and staging rows
// stay. Only the Reading index part changes, so these bounds catch index churn.
it('keeps the rows a web app favorite or archive writes to the file edit and its index row', { timeout: 120_000 }, async context => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('vault', 'hash', 'vault')").run();
	await env.DB.prepare('INSERT INTO reading_policy(id, enabled, folder_path, generation, revision) VALUES (1, ?, ?, ?, ?)').bind(policy.enabled, policy.folder_path, policy.generation, policy.revision).run();
	await env.DB.prepare("INSERT INTO reading_index(id, scope) VALUES (1, ?)").bind(readingIndexScope(policy)).run();
	const id = crypto.randomUUID();
	// An extracted article, as most saved notes are.
	const note = patchReadingFrontmatter(createReadingNote({ id, url: 'https://example.invalid/target', title: 'Target', savedAt: new Date().toISOString() }), { tags: ['research'], extraction_status: 'ready' });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Target.md', note.replace('<!-- crate:article:start -->\n', '<!-- crate:article:start -->\nArticle text.\n'), null);
	const measure = async (changes: Record<string, unknown>, before: Record<string, unknown>) => {
		const meter = meterD1Usage(env.DB);
		const response = await mutateReading({ ...env, DB: meter.db }, { tokenId: 'vault', scope: 'vault' }, policy,
			{ id, before, changes, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)) }, 'update');
		expect(response.status, await response.clone().text()).toBe(200);
		return { written: meter.usage.rowsWritten, read: meter.usage.rowsRead };
	};
	const favorite = await measure({ favorite: true }, { favorite: false });
	const archive = await measure({ reading_status: 'archived' }, { reading_status: 'inbox' });
	// Before: every index on the row was rewritten, 22 and 19 rows. A favorite or archive now also
	// moves the note between section indexes (two rows); its search terms are unchanged.
	expect(favorite.written).toBeLessThanOrEqual(20);
	expect(archive.written).toBeLessThanOrEqual(17);
	await context.annotate(JSON.stringify({ favorite, archive }), 'writes');
});
