import { D1_USAGE_HEADER } from '@/protocol/d1-usage';
import { CRATE_WEB_SESSION_NAME_HEADER } from '../../protocol/web-session';
import { ENCRYPTION_GENERATION_HEADER, ENCRYPTION_STATE_HEADER, ENCRYPTION_VAULT_HEADER } from '../../encryption/server-state';
import { CRATE_PROTOCOL_HEADER } from '../../protocol/server-info';
import { CLIENT_SESSION_HEADER, EXPECTED_HASH_HEADER, FILE_HASH_HEADER, FILE_SIZE_HEADER, INITIAL_IMPORT_HEADER, OPERATION_ID_HEADER, REQUEST_ID_HEADER,
	REVISION_HEADER, UPLOAD_OPERATION_HEADER, UPLOAD_OPERATIONS_HEADER } from '../../protocol/http-headers';

const ALLOW_HEADERS = ['Content-Type', 'Authorization', 'If-None-Match', FILE_HASH_HEADER, FILE_SIZE_HEADER, EXPECTED_HASH_HEADER,
	INITIAL_IMPORT_HEADER, UPLOAD_OPERATION_HEADER, UPLOAD_OPERATIONS_HEADER, CRATE_PROTOCOL_HEADER, OPERATION_ID_HEADER, CLIENT_SESSION_HEADER,
	ENCRYPTION_VAULT_HEADER, ENCRYPTION_GENERATION_HEADER, CRATE_WEB_SESSION_NAME_HEADER].join(', ');
const EXPOSE_HEADERS = [D1_USAGE_HEADER, 'Server-Timing', 'ETag', REVISION_HEADER, FILE_HASH_HEADER, FILE_SIZE_HEADER, REQUEST_ID_HEADER,
	ENCRYPTION_STATE_HEADER, 'Content-Type', 'Content-Length'].join(', ');

export function corsHeaders(): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': ALLOW_HEADERS,
		'Access-Control-Expose-Headers': EXPOSE_HEADERS,
	};
}

export function corsResponse(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'private, no-store',
			...corsHeaders(),
			...headers,
		},
	});
}
