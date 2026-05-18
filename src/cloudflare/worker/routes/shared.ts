import { corsResponse } from '../cors';

export type RouteMethod = Request['method'];

function requireDatabase(db: D1Database | null): D1Database | Response {
	return db ?? corsResponse({ error: 'Database not available' }, 503);
}

function isResponse(value: D1Database | Response): value is Response {
	return value instanceof Response;
}

export async function withDatabase(
	db: D1Database | null,
	handler: (db: D1Database) => Promise<Response>,
): Promise<Response> {
	const requiredDb = requireDatabase(db);
	return isResponse(requiredDb) ? requiredDb : handler(requiredDb);
}
