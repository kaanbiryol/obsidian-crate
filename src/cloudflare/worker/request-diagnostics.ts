import { BULK_NEW_UPLOAD_MAX_FILES } from '../../protocol/sync-limits';
import { reminderOperationDay } from '../../protocol/reminder-operation';
import type { AuthPrincipal } from './auth/authenticate';
import { MANAGED_FILE_OBJECT } from '../../protocol/storage-keys';
import { UPLOAD_OPERATION_HEADER, UPLOAD_OPERATIONS_HEADER, CLIENT_SESSION_HEADER, OPERATION_ID_HEADER } from '../../protocol/http-headers';

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
    clientSession: opaque(request.headers.get(CLIENT_SESSION_HEADER)) ?? null,
    operationId: opaque(request.headers.get(OPERATION_ID_HEADER)) ?? null,
  };
}

function fileRevision(value: unknown): value is string {
  return typeof value === 'string' && MANAGED_FILE_OBJECT.test(value);
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
    route: /^\/(sync|reminders|notifications|auth)\/(?:import\/)?[a-z-]+$/.test(path) ? path : 'other',
    clientSession: opaque(request.headers.get(CLIENT_SESSION_HEADER)),
    operationId: opaque(request.headers.get(OPERATION_ID_HEADER)),
    uploadOperationIds: (request.headers.get(UPLOAD_OPERATION_HEADER) ?? request.headers.get(UPLOAD_OPERATIONS_HEADER) ?? '').split(',').filter(id => reminderOperationDay(id) !== null).slice(0, BULK_NEW_UPLOAD_MAX_FILES),
    deviceId: principal.tokenId, scope: principal.scope, revisions, consumedRevisions, deleteRequestIds,
  });
}
