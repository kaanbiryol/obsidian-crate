import type CratePlugin from '../plugin/CratePlugin';
import { serverRequest } from '../plugin/server-request';

export interface ServerReadingPolicy { enabled: number; folder_path: string; generation: string; revision: string }
export function readingServerRequest<T>(plugin: CratePlugin, path: string, body?: unknown): Promise<T> {
  const capabilities: Record<string, string> = {
    'reading-v1': 'Update your Crate server to enable web Reading and phone saves.',
  };
  if (path === '/reading/fetching') capabilities['reading-fetching-consent-v1'] = 'Update your Crate server to manage article fetching.';
  if (path === '/reading/capture') capabilities['reading-deferred-captures-v1'] = 'Update your Crate server to finish pending Reading saves.';
  return serverRequest<T>(plugin, path, body, { capabilities });
}
