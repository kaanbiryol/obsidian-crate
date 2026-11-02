import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';

/** The client protocol, plus the bearer credential when there is one, for a request
 * sent outside `makeApiFetch`, which sets these itself. */
export function crateRequestHeaders(token?: string): Record<string, string> {
	return { ...token !== undefined ? { Authorization: `Bearer ${token}` } : {}, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) };
}
