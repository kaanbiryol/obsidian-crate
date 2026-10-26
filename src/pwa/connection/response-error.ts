/** A failed response as a short user-facing message. Crate servers answer with
 * `{ error, code }`; proxies and gateways may send HTML or plain text, which
 * becomes the fallback instead of being shown or saved with pending changes. */
export async function responseError(response: Response, fallback: string): Promise<{ message: string; code?: string }> {
	const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
	return {
		message: typeof body?.error === 'string' && body.error ? body.error : fallback,
		...(typeof body?.code === 'string' ? { code: body.code } : {}),
	};
}
