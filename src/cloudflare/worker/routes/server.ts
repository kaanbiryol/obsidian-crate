import { handleDiagnostics } from '../maintenance/diagnostics';
import { handleHealth } from '../sync/index';
import type { RouteMethod } from './shared';

/** Server status for connected clients. */
export async function handleServerRoute(
	db: D1Database,
	path: string,
	method: RouteMethod,
): Promise<Response | null> {
	if (path === '/health' && method === 'GET') return await handleHealth();
	if (path === '/diagnostics' && method === 'GET') return await handleDiagnostics(db);

	return null;
}
