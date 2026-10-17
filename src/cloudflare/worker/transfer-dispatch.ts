import type { Env } from './types';

type TransferPath = '/import-upload' | '/sync-upload' | '/sync-batch-upload' | '/batch-download' | '/history-checkpoint-create' | '/history-checkpoint' | '/history-checkpoint-file';
const READ_PATHS = new Set<TransferPath>(['/batch-download', '/history-checkpoint', '/history-checkpoint-file']);

/** A fixed compute pool keeps transfers parallel with one decoded batch per object.
 * Reads use a separate pool, so a slow upload body never delays downloads.
 * These instances use no Durable Object storage; file ownership stays in D1. */
export function forwardTransferRequest(request: Request, env: Env, path: TransferPath): Promise<Response> {
  const target = new URL(request.url); target.pathname = path;
  const shard = crypto.getRandomValues(new Uint8Array(1))[0]! % 8;
  const pool = READ_PATHS.has(path) ? 'transfer-read' : 'transfer';
  const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName(`__crate__/${pool}/${shard}`));
  return stub.fetch(new Request(target, request));
}
