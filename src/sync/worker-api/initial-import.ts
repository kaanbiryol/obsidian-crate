import { INITIAL_IMPORT_CAPABILITY, type InitialImport } from '@/protocol/initial-import';
import type { BatchUploadResponse } from '@/protocol/sync-types';
import { TRANSFER_TIMEOUT_MS, type WorkerApiHttpClient } from './http';
import { arrayBufferToBase64 } from '../encoding';
import type { PreparedUpload } from '../types';
import { BATCH_FILE_SIZE_LIMIT } from '@/protocol/sync-limits';

export class InitialImportApi {
  private establishedAt?: string;
  private pendingSetup?: { token: string; workerUrl: string };
  constructor(private http: WorkerApiHttpClient) {}

  async begin(): Promise<InitialImport | null> {
    if (this.establishedAt === this.http.getWorkerUrl()) return null;
    const info = await this.http.getServerInfo();
    if (!info.capabilities.includes(INITIAL_IMPORT_CAPABILITY)) return null;
    const response = await this.http.requestJson<{ import: InitialImport | null }>('/sync/import', { method: 'POST' });
    if (response.import === null) { this.establishedAt = this.http.getWorkerUrl(); return null; }
    if (!response.import || typeof response.import.token !== 'string' || !['importing', 'complete'].includes(response.import.state)) throw new Error('Invalid initial import response');
    if (response.import.state === 'complete') this.pendingSetup = { token: response.import.token, workerUrl: this.http.getWorkerUrl() };
    return response.import;
  }

  async upload(token: string, files: PreparedUpload[]): Promise<BatchUploadResponse> {
    const first = files[0];
    if (files.length === 1 && first && first.size >= BATCH_FILE_SIZE_LIMIT) {
      return this.http.requestJson(`/sync/import/upload?path=${encodeURIComponent(first.path)}`, {
        method: 'PUT', headers: { 'X-Crate-Import': token, 'X-File-Hash': first.hash,
          'X-Crate-Expected-Hash': first.expectedHash ?? 'absent', 'Content-Type': first.contentType || 'application/octet-stream' },
        body: first.content,
      }, TRANSFER_TIMEOUT_MS);
    }
    return this.http.requestJson('/sync/import/upload', { method: 'POST', headers: { 'X-Crate-Import': token }, body: JSON.stringify({ files: files.map(file => ({ path: file.path, hash: file.hash, size: file.size,
      content: arrayBufferToBase64(file.content), contentType: file.contentType, expectedHash: file.expectedHash ?? null })) }) }, TRANSFER_TIMEOUT_MS);
  }

  async prune(token: string, files: Array<{ path: string; hash: string }>): Promise<void> {
    for (let offset = 0; offset < files.length; offset += 50) {
      await this.http.requestJson('/sync/import/prune', { method: 'POST', body: JSON.stringify({ token, files: files.slice(offset, offset + 50) }) });
    }
  }

  async finish(token: string, inventoryHash: string): Promise<number> {
    const result = await this.http.requestJson<{ lastSeq: number }>('/sync/import/complete', { method: 'POST', body: JSON.stringify({ token, inventoryHash }) });
    if (!Number.isSafeInteger(result.lastSeq) || result.lastSeq < 1) throw new Error('Invalid initial import checkpoint');
    this.pendingSetup = { token, workerUrl: this.http.getWorkerUrl() };
    return result.lastSeq;
  }

  isPreparingReminders(): boolean { return this.pendingSetup?.workerUrl === this.http.getWorkerUrl(); }

  async finishReminderSetup(throwIfDestroyed: () => void): Promise<void> {
    if (this.pendingSetup && this.isPreparingReminders()) await this.waitUntilReady(this.pendingSetup.token, throwIfDestroyed);
  }

  async waitUntilReady(token: string, throwIfDestroyed: () => void): Promise<void> {
    const workerUrl = this.http.getWorkerUrl();
    // Bound a foreground wait; the durable marker survives a timeout, close or restart.
    const deadline = Date.now() + 3 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      throwIfDestroyed();
      if (this.http.getWorkerUrl() !== workerUrl) throw new Error('Sync connection changed during reminder setup');
      const status = await this.http.requestJson<{ ready: boolean; error?: string }>('/sync/import/readiness', {
        method: 'POST', body: JSON.stringify({ token }),
      });
      throwIfDestroyed();
      if (this.http.getWorkerUrl() !== workerUrl) throw new Error('Sync connection changed during reminder setup');
      if (status.ready === true) {
        this.establishedAt = workerUrl;
        if (this.pendingSetup?.token === token) this.pendingSetup = undefined;
        return;
      }
      if (status.ready !== false) throw new Error('Invalid reminder setup response');
      if (status.error) throw new Error(`Files uploaded. Reminder setup needs attention: ${status.error}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Files uploaded. Reminder setup is still running; sync again to check completion.');
  }
}
