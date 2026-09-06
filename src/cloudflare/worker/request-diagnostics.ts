import type { AuthPrincipal } from './authenticate';

function opaque(value: string | null): string | undefined {
  return value && /^[a-zA-Z0-9_-]{16,128}$/.test(value) ? value : undefined;
}

/** Correlate client attempts, receipts and file incarnations without logging paths or content. */
export async function logMutation(request: Request, response: Response, requestId: string, principal: AuthPrincipal): Promise<void> {
  let revisions: string[] = [];
  try {
    const body = await response.clone().json() as { revision?: unknown; results?: Array<{ revision?: unknown }> };
    revisions = [body.revision, ...(Array.isArray(body.results) ? body.results.map(item => item.revision) : [])]
      .filter((value): value is string => typeof value === 'string' && /^__crate__\/files\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(value));
  } catch { /* Some mutations have no JSON response. */ }
  const path = new URL(request.url).pathname;
  console.info('crate.mutation', {
    requestId, status: response.status, method: request.method,
    route: /^\/(sync|reminders|notifications|auth)\/[a-z-]+$/.test(path) ? path : 'other',
    clientSession: opaque(request.headers.get('X-Crate-Client-Session')),
    operationId: opaque(request.headers.get('X-Crate-Operation-Id')),
    deviceId: principal.tokenId, scope: principal.scope, revisions,
  });
}
