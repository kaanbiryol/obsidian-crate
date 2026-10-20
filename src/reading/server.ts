import type CratePlugin from '../plugin/CratePlugin';
import { serverRequest } from '../plugin/server-request';
import { isRecord } from '../platform/validation';
import { parseReadingPolicy, type ReadingPolicy, type ReadingPolicyUpdate } from '../protocol/reading-policy';

/** `/reading/policy` responds with `{ policy }`, which is null before Reading is set up. */
function responsePolicy(response: unknown): ReadingPolicy | null {
  const value = isRecord(response) ? response.policy : undefined;
  if (value === null) return null;
  const policy = parseReadingPolicy(value);
  if (!policy) throw new Error('Could not read Reading settings.');
  return policy;
}
export async function readReadingPolicy(plugin: CratePlugin): Promise<ReadingPolicy | null> {
  return responsePolicy(await serverRequest<unknown>(plugin, '/reading/policy'));
}
export async function writeReadingPolicy(plugin: CratePlugin, update: ReadingPolicyUpdate): Promise<ReadingPolicy> {
  const policy = responsePolicy(await serverRequest<unknown>(plugin, '/reading/policy', update));
  if (!policy) throw new Error('Could not read Reading settings.');
  return policy;
}
