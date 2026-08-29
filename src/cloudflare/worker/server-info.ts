import {
	CRATE_PLUGIN_PROTOCOL,
	CRATE_SERVICE_ID,
	type CrateServerInfo,
} from '../../protocol';
import { corsResponse } from './cors';

declare const __CRATE_SERVER_VERSION__: string | undefined;

const CRATE_SERVER_VERSION =
	typeof __CRATE_SERVER_VERSION__ === 'string' && __CRATE_SERVER_VERSION__.length > 0
		? __CRATE_SERVER_VERSION__
		: 'dev';

export const CRATE_SERVER_INFO: CrateServerInfo = Object.freeze({
	service: CRATE_SERVICE_ID,
	serverVersion: CRATE_SERVER_VERSION,
	protocol: CRATE_PLUGIN_PROTOCOL,
	capabilities: Object.freeze([
		'sync-v2',
		'conditional-file-mutations',
		'settings-v1',
		'devices-v1',
		'reminders-v1',
		'notifications-v1',
	]),
});

export function handleServerInfo(): Response {
	return corsResponse(CRATE_SERVER_INFO, 200, { 'Cache-Control': 'no-store' });
}
