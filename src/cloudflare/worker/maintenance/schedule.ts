import type { Env } from '../types';
import { requestMaintenance } from '../coordinator/coordinator';

// The cleanup alarm runs 24 hours after it is armed, so confirming it once per
// isolate every few minutes keeps the same schedule without a call per mutation.
// A finished episode is armed again by the first mutation after this interval.
const CONFIRMED_FOR_MS = 10 * 60 * 1000;
const confirmedAt = new WeakMap<object, number>();

/** Arms the cleanup object; `scope` is a stable binding or object state. */
export async function scheduleMaintenance(env: Env, scope: object): Promise<void> {
	const confirmed = confirmedAt.get(scope);
	if (confirmed !== undefined && Date.now() - confirmed < CONFIRMED_FOR_MS) return;
	if (!await requestMaintenance(env)) throw new Error('Unable to schedule server cleanup');
	confirmedAt.set(scope, Date.now());
}
