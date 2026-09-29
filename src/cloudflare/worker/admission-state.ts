import { sha256Hex } from './auth';

interface Budget { expires: number; count: number }
interface AdmissionState { credentials: Map<string, number>; budgets: Map<string, Budget>; overflow: Budget }
const states = new WeakMap<object, AdmissionState>();
const unavailableDatabase = {};
const WINDOW = 60_000;
const MAX_ENTRIES = 512;
function state(db: D1Database): AdmissionState {
	const identity = db ?? unavailableDatabase;
	let value = states.get(identity);
	if (!value) {
		value = { credentials: new Map(), budgets: new Map(), overflow: { expires: 0, count: 0 } };
		states.set(identity, value);
	}
	return value;
}
async function credential(request: Request): Promise<string | undefined> {
	const header = request.headers.get('Authorization');
	if (!header?.startsWith('Bearer ') || !header.slice(7).trim()) return undefined;
	return sha256Hex(`${new URL(request.url).host}\0${header.slice(7).trim()}`);
}

/** Admission hint only. Every request still authenticates against D1, including
 * revocation/expiry checks. No principal, token, or authorization is cached. */
export async function rememberAuthenticatedRequest(request: Request, db: D1Database, authenticated: boolean): Promise<void> {
	const key = await credential(request);
	if (!key) return;
	const { credentials } = state(db);
	const now = Date.now();
	for (const [entry, expires] of credentials) if (expires <= now) credentials.delete(entry);
	if (!authenticated) credentials.delete(key);
	else if (credentials.has(key) || credentials.size < MAX_ENTRIES) credentials.set(key, now + WINDOW);
}
export async function authenticatedAdmissionKey(request: Request, db: D1Database): Promise<string | undefined> {
	const key = await credential(request);
	return key && (state(db).credentials.get(key) ?? 0) > Date.now() ? key : undefined;
}

/** Bounded per-isolate fallback, keyed by the original binding, never its
 * request-local metering wrapper. Overflow shares one restrictive budget. */
export function admitLocally(db: D1Database, key: string, limit: number): boolean {
	const value = state(db), now = Date.now();
	for (const [entry, budget] of value.budgets) if (budget.expires <= now) value.budgets.delete(entry);
	let budget = value.budgets.get(key);
	if (!budget) {
		if (value.budgets.size < MAX_ENTRIES) {
			budget = { expires: now + WINDOW, count: 0 }; value.budgets.set(key, budget);
		} else {
			budget = value.overflow;
			if (budget.expires <= now) { budget.expires = now + WINDOW; budget.count = 0; }
			limit = 60;
		}
	}
	if (budget.count >= limit) return false;
	budget.count++;
	return true;
}
