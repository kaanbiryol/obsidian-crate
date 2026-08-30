export function corsHeaders(): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-None-Match, X-File-Hash, X-File-Size, X-Crate-Expected-Hash, X-Crate-Enrollment-Token',
		'Access-Control-Expose-Headers': 'ETag, X-File-Hash, X-File-Size, Content-Type, Content-Length',
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
			...corsHeaders(),
			...headers,
		},
	});
}
