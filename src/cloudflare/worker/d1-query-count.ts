/** D1 work as Cloudflare's per-invocation query limit counts it: one query per
 * first/run/all, one per exec and one per batch, whatever its size. */
export interface D1QueryCount { queries: number; statements: number }

/** Returns a view of `db` that adds each query it runs to `count`. Batch statements
 * prepared by the view through the view, which passes the binding its own statements. */
export function countD1Queries(db: D1Database, count: D1QueryCount = { queries: 0, statements: 0 }): { db: D1Database; count: D1QueryCount } {
	const add = (statements: number) => { count.queries++; count.statements += statements; };
	const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
	const counted = (statement: D1PreparedStatement): D1PreparedStatement => {
		const view: D1PreparedStatement = {
			bind: (...values) => counted(statement.bind(...values)),
			first: <T>() => { add(1); return statement.first<T>(); },
			run: () => { add(1); return statement.run(); },
			all: <T>() => { add(1); return statement.all<T>(); },
		};
		originals.set(view, statement);
		return view;
	};
	return { count, db: {
		prepare: sql => counted(db.prepare(sql)),
		batch: statements => { add(statements.length); return db.batch(statements.map(statement => originals.get(statement) ?? statement)); },
		exec: query => { add(1); return db.exec(query); },
	} };
}
