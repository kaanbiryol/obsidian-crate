import type CratePlugin from '../plugin/CratePlugin';
import { serverRequest } from '../plugin/server-request';

export interface ServerReadingPolicy { enabled: number; folder_path: string; generation: string; revision: string }
export function readingServerRequest<T>(plugin: CratePlugin, path: string, body?: unknown): Promise<T> {
  return serverRequest<T>(plugin, path, body);
}
