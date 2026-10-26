import type { apiRoutePolicy } from './policy';

type RouteExecution = NonNullable<ReturnType<typeof apiRoutePolicy>>['execution'];

/** Where an admitted request runs. Admission, authentication and guards keep
 * their fixed order in the request handler around these steps. */
export type RequestPlacement =
	/** One-use public Reading grants are redeemed under the coordinator lock. */
	| 'forward-grant'
	| 'redeem-grant'
	/** Coordinator routes authenticate once, under the lock every revocation also takes. */
	| 'forward-before-auth'
	/** The shortcut capture authenticates at the edge, where an encrypted vault downloads its page. */
	| 'forward-after-auth'
	/** Streamed to a transfer object after authentication, without reading the body here. */
	| 'forward-transfer'
	| 'here';

export function requestPlacement(route: RouteExecution, running: 'public' | 'coordinator' | 'transfer', shortcutPrepare: boolean): RequestPlacement {
	if (route?.kind === 'reading-grant') return running === 'coordinator' ? 'redeem-grant' : 'forward-grant';
	if (running === 'coordinator') return 'here';
	if (route?.kind === 'coordinator') return shortcutPrepare ? 'forward-after-auth' : 'forward-before-auth';
	if (route?.kind === 'transfer' && running === 'public') return 'forward-transfer';
	return 'here';
}
