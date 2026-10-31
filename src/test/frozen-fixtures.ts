import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * Frozen samples of a durable format: stored data or wire bodies that released
 * clients and servers already depend on. Each `*.fixtures.test.ts` lists its
 * entries; this helper reads them and fails on a missing file instead of
 * regenerating it.
 *
 * A fixture file holds `{ stored, decoded }`: the bytes or JSON as they were
 * written, and what the decoder returned when the fixture was frozen. The test
 * decodes `stored` with today's code and requires every `decoded` value again
 * (new output fields are allowed).
 * A `canonical` entry also re-encodes `stored` (a string) and requires the
 * identical bytes.
 *
 * To freeze a new version, append an entry with a new file name, then run
 * `CRATE_WRITE_FIXTURES=<file name> npx vitest run <test file>`. Only that
 * missing file is written; the run still fails so the new file is reviewed and
 * committed. Never edit, rename or regenerate an existing fixture: a failure
 * means stored data or a released client would break.
 */
export interface FrozenFixture {
	/** File name inside the test's `__fixtures__` folder, such as `checkpoint.v1.json`. */
	file: string;
	/** Builds the stored value with today's writer. Runs only while freezing a new file. */
	stored: () => unknown;
	/** Decodes a stored value into a JSON-serializable result. */
	decode: (stored: never) => unknown;
	/** Re-encodes a stored string; the result must equal it byte for byte. */
	canonical?: (stored: never) => string | Promise<string>;
}

const requested = new Set((process.env.CRATE_WRITE_FIXTURES ?? '').split(',').filter(Boolean));
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

/** Registers one test per fixture plus a check that no fixture file is unlisted. */
export function testFrozenFixtures(directory: URL, fixtures: readonly FrozenFixture[]): void {
	it('lists every committed fixture', () => {
		const listed = new Set(fixtures.map(fixture => fixture.file));
		expect(listed.size).toBe(fixtures.length);
		const present = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')) : [];
		// Removing an entry would stop checking a format that stored data still uses.
		expect(present.filter(name => !listed.has(name))).toEqual([]);
	});
	it.each(fixtures.map(fixture => [fixture.file, fixture] as const))('still decodes %s', async (_name, fixture) => {
		const url = new URL(fixture.file, directory);
		if (!existsSync(url)) {
			if (!requested.has(fixture.file)) throw new Error(`Missing frozen fixture ${fixture.file}. Fixtures are append-only: restore it from Git rather than regenerating it.`);
			const stored = await fixture.stored();
			writeFileSync(url, `${JSON.stringify({ stored, decoded: json(await fixture.decode(stored as never)) }, null, '\t')}\n`);
			throw new Error(`Wrote ${fixture.file}. Review it, commit it and run the test again.`);
		}
		const saved = JSON.parse(readFileSync(url, 'utf8')) as { stored: unknown; decoded: unknown };
		// Additive decoder output is allowed; every frozen value must still decode unchanged.
		expect(json(await fixture.decode(saved.stored as never))).toMatchObject(saved.decoded as object);
		if (fixture.canonical) {
			expect(typeof saved.stored).toBe('string');
			expect(await fixture.canonical(saved.stored as never)).toBe(saved.stored);
		}
	});
}
