import type { Env } from './types';

/** A fixed compute pool keeps transfers parallel with one decoded batch per object.
 * These instances use no Durable Object storage; file ownership stays in D1. */
export function forwardTransferRequest(request: Request, env: Env, path: '/import-upload' | '/batch-download' | '/history-checkpoint-create' | '/history-checkpoint' | '/history-checkpoint-file'): Promise<Response> {
  const target = new URL(request.url); target.pathname = path;
  const shard = crypto.getRandomValues(new Uint8Array(1))[0]! % 8;
  const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName(`__crate__/transfer/${shard}`));
  return stub.fetch(new Request(target, request));
}
