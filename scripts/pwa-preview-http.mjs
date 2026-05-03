export function send(res, statusCode, body, headers = {}) {
	res.writeHead(statusCode, {
		'Cache-Control': 'no-store',
		...headers,
	});
	res.end(body);
}

export function sendJson(res, statusCode, payload) {
	send(res, statusCode, JSON.stringify(payload), {
		'Content-Type': 'application/json; charset=utf-8',
	});
}

export function sendText(res, statusCode, body, contentType) {
	send(res, statusCode, body, {
		'Content-Type': contentType,
	});
}

export async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	if (chunks.length === 0) {
		return {};
	}

	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
