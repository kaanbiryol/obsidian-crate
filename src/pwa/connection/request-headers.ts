import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER, isCrateMutation } from '@/protocol/server-info';
import { forgetCompatibleProtocol, requireCompatibleProtocol } from './server-compatibility';
import { responseError } from './response-error';

/** The protocol a request carries: the one negotiated with the server for a change,
 * the client's current one for a read. */
export async function crateProtocol(path: string, method = 'GET'): Promise<number> {
	return isCrateMutation(path, method) ? await requireCompatibleProtocol() : CRATE_PLUGIN_PROTOCOL.current;
}

/** The client protocol, plus the bearer credential when there is one, for a request
 * sent outside `makeApiFetch`, which sets these itself. A change passes the protocol
 * `crateProtocol` negotiated. */
export function crateRequestHeaders(token?: string, protocol = CRATE_PLUGIN_PROTOCOL.current): Record<string, string> {
	return { ...token !== undefined ? { Authorization: `Bearer ${token}` } : {}, [CRATE_PROTOCOL_HEADER]: String(protocol) };
}

/** The server refused the negotiated protocol; the next change reads server info again. */
export async function forgetRefusedProtocol(response: Response): Promise<void> {
	if (response.status === 428 && (await responseError(response.clone(), '')).code === 'protocol_incompatible') forgetCompatibleProtocol();
}
