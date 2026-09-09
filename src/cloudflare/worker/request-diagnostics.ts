import { reminderOperationDay } from '../../protocol/reminder-operation';
import type { AuthPrincipal } from './authenticate';

function opaque(value: string | null): string | undefined {
  return value && /^[a-zA-Z0-9_-]{16,128}$/.test(value) ? value : undefined;
}

export interface MutationAuditContext {
  requestId: string;
  deviceId: string | null;
  clientSession: string | null;
  operationId: string | null;
}

export function mutationAuditContext(request: Request, principal?: AuthPrincipal, requestId: string = crypto.randomUUID()): MutationAuditContext {
  return {
    requestId, deviceId: principal?.tokenId ?? null,
    clientSession: opaque(request.headers.get('X-Crate-Client-Session')) ?? null,
    operationId: opaque(request.headers.get('X-Crate-Operation-Id')) ?? null,
  };
}

function fileRevision(value: unknown): value is string {
  return typeof value === 'string' && /^__crate__\/files\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(value);
}

/** Correlate client attempts, receipts and file incarnations without logging paths or content. */
export async function logMutation(request: Request, response: Response, requestId: string, principal: AuthPrincipal): Promise<void> {
  let revisions: string[] = [];
  let consumedRevisions: string[] = [];
  let deleteRequestIds: string[] = [];
  try {
    interface MutationResult { revision?: unknown; consumedRevision?: unknown; deleteRequestId?: unknown }
    const body = await response.clone().json() as MutationResult & { results?: MutationResult[] };
    const results = [body, ...(Array.isArray(body.results) ? body.results : [])];
    revisions = results.map(item => item.revision).filter((value): value is string => fileRevision(value)
      || typeof value === 'string' && /^__crate__\/deletions\/[a-f0-9-]{36}$/.test(value));
    consumedRevisions = results.map(item => item.consumedRevision).filter(fileRevision);
    deleteRequestIds = [...new Set(results.map(item => item.deleteRequestId).filter((value): value is string => typeof value === 'string' && opaque(value) !== undefined))];
  } catch { /* Some mutations have no JSON response. */ }
  const path = new URL(request.url).pathname;
  console.info('crate.mutation', {
    requestId, status: response.status, method: request.method,
    route: /^\/(sync|reminders|notifications|auth)\/[a-z-]+$/.test(path) ? path : 'other',
    clientSession: opaque(request.headers.get('X-Crate-Client-Session')),
    operationId: opaque(request.headers.get('X-Crate-Operation-Id')),
    uploadOperationIds: (request.headers.get('X-Crate-Upload-Operation') ?? request.headers.get('X-Crate-Upload-Operations') ?? '').split(',').filter(id => reminderOperationDay(id) !== null).slice(0, 3),
    deviceId: principal.tokenId, scope: principal.scope, revisions, consumedRevisions, deleteRequestIds,
  });
}
