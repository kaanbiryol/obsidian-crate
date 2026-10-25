import type CratePlugin from '../plugin/CratePlugin';
import { serverRequest } from '../plugin/server-request';
import { isRecord } from '../platform/validation';
import { parseReadingPolicy, type ReadingPolicy, type ReadingPolicyUpdate } from '../protocol/reading-policy';

/** `/reading/policy` responds with `{ policy }`, which is null before Reading is set up.
 * An encrypted vault names the folder by its tag; the result uses the plaintext folder. */
async function responsePolicy(plugin: CratePlugin, response: unknown): Promise<ReadingPolicy | null> {
  const value = isRecord(response) ? response.policy : undefined;
  if (value === null) return null;
  const policy = parseReadingPolicy(value);
  if (!policy) throw new Error('Could not read Reading settings.');
  const { folder_label: label, ...plain } = policy;
  if (label === undefined) return plain;
  const api = plugin.syncRuntime.getApiClient();
  if (!api) throw new Error('Connect sync to read encrypted Reading settings.');
  return { ...plain, folder_path: await api.localFolder(policy.folder_path, label) };
}
export async function readReadingPolicy(plugin: CratePlugin): Promise<ReadingPolicy | null> {
  return responsePolicy(plugin, await serverRequest<unknown>(plugin, '/reading/policy'));
}
export async function writeReadingPolicy(plugin: CratePlugin, update: ReadingPolicyUpdate): Promise<ReadingPolicy> {
  const folder = await plugin.syncRuntime.getApiClient()?.serverFolder(update.folderPath) ?? { folderPath: update.folderPath };
  const policy = await responsePolicy(plugin, await serverRequest<unknown>(plugin, '/reading/policy', { ...update, ...folder }));
  if (!policy) throw new Error('Could not read Reading settings.');
  return policy;
}
