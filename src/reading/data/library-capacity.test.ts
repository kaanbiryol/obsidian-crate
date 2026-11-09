import { expect, it } from 'vitest';
import { ReadingLibrary, type ReadingFile, type ReadingVault } from './library';
import { createReadingNote } from '../core/notes';
import { readReadingFrontmatter } from '../core/frontmatter';
import { ARTICLE_END, ARTICLE_START } from '../core/model';
import { filterReadingItems } from '../core/reading-presentation';

// A repeatable local measurement of the plugin's Reading library, not a device claim.
// `npm run benchmark:reading` sets 50,000 notes; the ordinary suite keeps it small.
const NOTES = Number(process.env.READING_CAPACITY_NOTES ?? 2_000);
const ARTICLE = Array.from({ length: 12 }, (_, line) => `Synthetic paragraph ${line} with enough text to resemble a saved article.`).join('\n\n');

/** Synthetic notes in memory. Obsidian's frontmatter cache is computed up front, as
 * Obsidian has already indexed the vault when Reading starts. */
function syntheticVault(count: number) {
	const contents = new Map<string, string>(), versions = new Map<string, number>(), properties = new Map<string, Record<string, unknown>>();
	const counters = { reads: 0, walks: 0, lookups: 0 };
	const file = (path: string): ReadingFile => ({ path, size: contents.get(path)!.length, modifiedAt: 1, revision: `${path}:${versions.get(path)}` });
	const put = (path: string, content: string) => {
		contents.set(path, content);
		versions.set(path, (versions.get(path) ?? 0) + 1);
		properties.set(path, readReadingFrontmatter(content)!.value);
	};
	for (let index = 0; index < count; index++) {
		const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
		const savedAt = new Date(Date.UTC(2020, 0, 1) + index * 60_000).toISOString();
		const note = createReadingNote({ id, url: `https://example.invalid/articles/${index}`, title: `Article ${index}`, savedAt });
		put(`Reading/Article ${index}.md`, note.replace(`${ARTICLE_START}\n${ARTICLE_END}`, `${ARTICLE_START}\n${ARTICLE}\n${ARTICLE_END}`));
	}
	const vault: ReadingVault & { file(path: string): ReadingFile | null; cachedProperties(file: ReadingFile): Record<string, unknown> | undefined } = {
		files: () => { counters.walks++; return [...contents.keys()].map(file); },
		file: path => { counters.lookups++; return contents.has(path) ? file(path) : null; },
		cachedProperties: current => properties.get(current.path),
		read: async current => { counters.reads++; return contents.get(current.path)!; },
		process: async (current, update) => {
			counters.reads++;
			const next = update(contents.get(current.path)!);
			put(current.path, next);
			return next;
		},
		create: async (path, content) => { put(path, content); },
		occupied: path => contents.has(path),
	};
	return { vault, counters };
}

async function measure<T>(counters: { reads: number; walks: number }, action: () => Promise<T> | T) {
	const before = { ...counters }, start = performance.now();
	const result = await action();
	return { result, sample: { ms: Math.round(performance.now() - start), reads: counters.reads - before.reads, walks: counters.walks - before.walks } };
}

it(`loads and edits a ${NOTES}-note Reading library`, { timeout: 600_000 }, async context => {
	const { vault, counters } = syntheticVault(NOTES);
	const library = new ReadingLibrary(vault, 'Reading', new AbortController().signal);
	const startup = await measure(counters, () => library.refresh());
	const items = library.getSnapshot().items;
	expect(items).toHaveLength(NOTES);
	const target = items[Math.floor(NOTES / 2)]!;
	const favorite = await measure(counters, () => library.update(target, { favorite: true }));
	const archived = library.getSnapshot().items.find(item => item.crate_reading_id === target.crate_reading_id)!;
	const status = await measure(counters, () => library.update(archived, { reading_status: 'archived' }));
	const add = await measure(counters, () => library.add('https://example.invalid/new-article', 'New article', false));
	const addAgain = await measure(counters, () => library.add('https://example.invalid/another-article', 'Another article', false));
	expect(library.getSnapshot().items).toHaveLength(NOTES + 2);
	const search = await measure(counters, () => filterReadingItems(library.getSnapshot().items, 'inbox', 'article 4', null));
	expect(search.result.length).toBeGreaterThan(0);
	await library.close();
	await context.annotate(JSON.stringify({
		scenario: 'plugin-reading-library', localOnly: true, notes: NOTES,
		startup: startup.sample, favorite: favorite.sample, status: status.sample, add: add.sample, addAgain: addAgain.sample, search: search.sample,
	}), 'capacity');
});
