import type CratePlugin from '../plugin/CratePlugin';
import { captureServerConnection } from '../plugin/server-request';
import { SECRET_KEYS } from '../plugin/settings-types';
import { loadEncryptionKeys } from '../plugin/encryption-storage';
import { SyncApiClient } from '../sync/api';
import { WorkerApiHttpClient } from '../sync/worker-api/http';
import { LocalManifest } from '../sync/manifest';
import { getCheckpointAuthority } from '../sync/worker-url';
import { reminderOperationDay } from '../protocol/reminder-operation';
import { portablePathKey } from '../protocol/portable-path';
import { captureAuthority, parseCaptureRecord } from './data/capture-outbox';
import { parseReadingNote } from './core/notes';
import { MAX_READING_BYTES, readingUrlIdentity } from './core/model';
import { readingCapturePath } from './core/filename';
import { recoverCaptureReceipt, type CaptureRecoveryReceipt } from './capture-recovery-receipt';

/** The sync engine and Reading runtime must be stopped. Recover old immutable
 * capture intents into local notes after conversion, without retargeting a
 * possibly accepted request. Keep the originals until the note and its remote
 * deletion dependency are durable. Only queued captures cause recovery reads. */
export async function recoverMovedReadingCaptures(plugin: CratePlugin): Promise<void> {
  const { vault } = plugin.app, adapter = vault.adapter;
  const directory = `${vault.configDir}/plugins/${plugin.manifest.id}/reading-captures`;
  if (!await adapter.exists(directory)) return;
  const files = (await adapter.list(directory)).files.filter(path => path.endsWith('.json'));
  if (!files.length) return;
  if (files.length > 200) throw new Error('Too many pending Reading saves. Their original files are preserved.');
  const connection = captureServerConnection(plugin), keys = loadEncryptionKeys(plugin.secretStorage);
  if (!keys) throw new Error('Unlock Reading before recovering its pending saves.');
  const snapshot = plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES), folder = plugin.settings.reading.folderPath;
  const guard = () => {
    connection.assertCurrent();
    if (snapshot !== plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES) || folder !== plugin.settings.reading.folderPath) throw new Error('Reading moved again. Resume the saved folder move.');
  };
  const authorities = await Promise.all([getCheckpointAuthority(plugin.settings), connection.origin].map(origin => captureAuthority(origin, connection.token)));
  const api = new SyncApiClient(connection.origin, connection.token ?? ''); api.setAbortSignal(connection.signal);
  await api.configureEncryption(keys);
  const http = new WorkerApiHttpClient(connection.origin, connection.token ?? ''); http.setAbortSignal(connection.signal); http.setEncryptionAuthority(keys.vaultId, keys.generation);
  let remote: Awaited<ReturnType<SyncApiClient['getManifest']>> | undefined;
  // Cache only identity metadata: many queued saves must not redownload the
  // whole library each time or retain complete article bodies on mobile.
  type Identity = { id: string; url: string } | null;
  const indexed = new Map<string, Identity>(); let indexBytes = 0;
  const identity = (content: string): Identity => {
    const item = parseReadingNote(content);
    return item ? { id: item.crate_reading_id, url: item.source_url ? readingUrlIdentity(item.source_url) : '' } : null;
  };
  const manifest = new LocalManifest(plugin.app, plugin.manifest, getCheckpointAuthority(plugin.settings));
  try {
    await manifest.load();
    for (const file of files) {
      const raw = await adapter.read(file), record = parseCaptureRecord(raw);
      if (!authorities.includes(record.authority)) throw new Error('Pending Reading saves belong to another server. Their original files are preserved.');
      if (reminderOperationDay(record.body.operationId) === null) throw new Error('Invalid saved Reading operation.');
      guard();
      const attemptFile = `${vault.configDir}/plugins/${plugin.manifest.id}/reading-encrypted-attempts/${keys.vaultId}-${record.body.operationId}.json`;
      const attempt = await adapter.exists(attemptFile) ? JSON.parse(await adapter.read(attemptFile)) as { requestHash: string; body: string } : undefined;
      const receipt = await http.requestJson<CaptureRecoveryReceipt>(`/encryption/capture-recovery?operationId=${encodeURIComponent(record.body.operationId)}`);
      const acceptedId = await recoverCaptureReceipt(record, receipt, keys, attempt);
      const matches = (item: Identity) => item && (acceptedId ? item.id === acceptedId : item.id === record.body.captureId || item.url === readingUrlIdentity(record.body.url));
      const local = [];
      for (const note of vault.getMarkdownFiles().filter(note => note.path.startsWith(folder + '/'))) {
        if (note.stat.size <= MAX_READING_BYTES && matches(identity(await vault.read(note)))) local.push(note.path);
      }
      if (local.length > 1) throw new Error('Several local notes match a pending Reading save. Resolve the duplicates before resuming.');
      remote ??= await api.getManifest();
      const candidates = Object.entries(remote.files).filter(([path]) => path.toLowerCase().endsWith('.md') && [folder, record.folder].some(parent => path.startsWith(parent + '/')));
      if (candidates.length > 10_000) throw new Error('Reading recovery exceeds this device’s library limit.');
      let source: { path: string; content: string } | undefined;
      for (const [path, entry] of candidates) {
        if (entry.size > MAX_READING_BYTES) continue;
        if (indexed.has(path) && !matches(indexed.get(path)!)) continue;
        const downloaded = await api.downloadFile(path);
        if (downloaded.hash !== entry.hash || downloaded.revision !== entry.revision) throw new Error('Reading changed during recovery. Resume the folder move.');
        const content = new TextDecoder('utf-8', { fatal: true }).decode(downloaded.content);
        const item = identity(content);
        if (!indexed.has(path)) indexBytes += JSON.stringify(item).length * 2;
        if (indexBytes > 12 * 1024 * 1024) throw new Error('Reading recovery exceeds this device’s library limit.');
        indexed.set(path, item);
        if (!matches(item)) continue;
        if (source) throw new Error('Several remote notes match a pending Reading save. Resolve the duplicates before resuming.');
        source = { path, content };
      }
      if (acceptedId && !source && !local.length) throw new Error('A previously saved Reading article moved or was deleted. Its pending capture is preserved for recovery.');
      guard();
      let destination = local[0];
      if (source && source.path !== destination && vault.getAbstractFileByPath(source.path)) throw new Error('The original Reading article still exists locally. Move it to the Reading folder before resuming.');
      if (!destination) {
        const content = source?.content ?? record.note, item = parseReadingNote(content)!;
        destination = await readingCapturePath(folder, 'Article', item.crate_reading_id, path => vault.getAllLoadedFiles().some(file => portablePathKey(file.path) === portablePathKey(path)));
        const parts = folder.split('/');
        for (let count = 1; count <= parts.length; count++) {
          guard(); const part = parts.slice(0, count).join('/');
          if (!vault.getAbstractFileByPath(part)) await vault.createFolder(part);
        }
        guard(); await vault.create(destination, content);
      }
      guard();
      const current = vault.getAbstractFileByPath(destination);
      const localContent = current ? await adapter.read(destination) : '';
      if (!current || !matches(identity(localContent))) throw new Error('The local Reading article changed during recovery.');
      guard();
      if (source && source.path !== destination) {
        // An existing baseline lets normal sync reconcile newer remote edits.
        // Without one, differing copies are not proof of a completed download.
        if (identity(localContent)?.id !== identity(source.content)?.id || !manifest.getEntry(source.path) && localContent !== source.content) throw new Error('Local and remote Reading copies differ. Compare them before resuming.');
        if (!manifest.getEntry(source.path)) manifest.setEntry(source.path, remote.files[source.path]!);
        manifest.recordRename(source.path, destination);
      }
      await manifest.save(); guard();
      if (await adapter.read(file) !== raw) throw new Error('The pending Reading save changed during recovery.');
      guard(); await adapter.remove(file);
      // A stale encrypted attempt cannot dispatch by itself; preserve it if
      // cleanup fails after the original capture has been safely settled.
      guard(); if (await adapter.exists(attemptFile)) { guard(); await adapter.remove(attemptFile); }
    }
  } finally { await manifest.close(); }
}
