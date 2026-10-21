import type { Env } from '../types';
import { TRANSFER_PATHS, transferStub, type TransferPath } from '../coordinator/coordinator';

const READ_PATHS = new Set<TransferPath>([TRANSFER_PATHS.batchDownload, TRANSFER_PATHS.historyCheckpoint, TRANSFER_PATHS.historyCheckpointFile]);

/** A fixed compute pool keeps transfers parallel with one decoded batch per object.
 * Reads use a separate pool, so a slow upload body never delays downloads.
 * These instances use no Durable Object storage; file ownership stays in D1. */
export function forwardTransferRequest(request: Request, env: Env, path: TransferPath): Promise<Response> {
  const target = new URL(request.url); target.pathname = path;
  return transferStub(env, READ_PATHS.has(path) ? 'transfer-read' : 'transfer').fetch(new Request(target, request));
}
