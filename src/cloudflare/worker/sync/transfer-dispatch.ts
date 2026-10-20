import type { Env } from '../types';
import { transferStub } from '../coordinator/coordinator';

type TransferPath = '/import-upload' | '/sync-upload' | '/sync-batch-upload' | '/batch-download' | '/history-checkpoint-create' | '/history-checkpoint' | '/history-checkpoint-file';
const READ_PATHS = new Set<TransferPath>(['/batch-download', '/history-checkpoint', '/history-checkpoint-file']);

/** A fixed compute pool keeps transfers parallel with one decoded batch per object.
 * Reads use a separate pool, so a slow upload body never delays downloads.
 * These instances use no Durable Object storage; file ownership stays in D1. */
export function forwardTransferRequest(request: Request, env: Env, path: TransferPath): Promise<Response> {
  const target = new URL(request.url); target.pathname = path;
  return transferStub(env, READ_PATHS.has(path) ? 'transfer-read' : 'transfer').fetch(new Request(target, request));
}
