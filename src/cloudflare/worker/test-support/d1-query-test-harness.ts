import { vi } from 'vitest';
import { countD1Queries, type D1QueryCount } from '../d1/d1-query-count';

/** Counts queries made through the `db` binding itself, for code that reads it
 * directly, until mocks are restored. The test isolate also runs the coordinator,
 * so pass a counted view to one invocation instead where the code allows it. */
export function installD1QueryCounter(db: D1Database): D1QueryCount & { reset(): void } {
	const { db: counted, count } = countD1Queries({ prepare: db.prepare.bind(db), batch: db.batch.bind(db), exec: db.exec.bind(db) });
	vi.spyOn(db, 'prepare').mockImplementation(sql => counted.prepare(sql));
	vi.spyOn(db, 'batch').mockImplementation(statements => counted.batch(statements));
	vi.spyOn(db, 'exec').mockImplementation(query => counted.exec(query));
	return Object.assign(count, { reset() { count.queries = 0; count.statements = 0; } });
}
