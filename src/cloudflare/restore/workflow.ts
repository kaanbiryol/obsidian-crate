import type { CloudflareApiClient } from '../cloudflare-api';
import type { CloudflareDeploymentArtifacts } from '../deployment-artifacts';
import type { CloudflareDeploymentMetadata } from '../deployment-types';
import { randomHex } from '../pkce';
import type { BackupChoice } from './archive';
import type { ServerRestoreState } from './state';

/** Keep checkpoint selection and durable destination identity ahead of remote work. */
export async function runRestoreWorkflow(input: {
  api: CloudflareApiClient;
  source: CloudflareDeploymentMetadata;
  artifacts: CloudflareDeploymentArtifacts;
  choice: BackupChoice | null;
  saved: ServerRestoreState | null | undefined;
  now: () => number;
  persist: (state: ServerRestoreState) => Promise<void>;
  onProgress: (message: string) => void;
}): Promise<string> {
  const { api, source, artifacts, choice, saved, now, persist, onProgress } = input;
  let state: ServerRestoreState;
  if (saved && (saved.phase !== 'complete' || !choice)) state = structuredClone(saved);
  else {
    if (!choice) throw new Error('Select a backup first');
    const id = randomHex(8), resourceName = `crate-${id}`;
    state = {
      id,
      source: { account: source.accountId!, database: source.d1DatabaseId!, bucket: source.r2BucketName },
      prefix: choice.prefix, archiveHash: choice.hash, fingerprint: artifacts.fingerprint,
      restoredAt: now(), phase: 'copying',
      target: {
        deploymentId: id, vaultName: `${source.vaultName ?? 'Crate'} (restored)`,
        accountId: source.accountId, accountName: source.accountName,
        workerName: resourceName, d1DatabaseName: resourceName, d1DatabaseId: null,
        r2BucketName: resourceName, workersSubdomain: source.workersSubdomain,
        lastDeployedVersion: null, lastDeployedFingerprint: null,
      },
    };
  }
  if (state.source.account !== source.accountId || state.source.database !== source.d1DatabaseId || state.source.bucket !== source.r2BucketName) {
    throw new Error('Reconnect to the backup’s original server before resuming.');
  }
  const save = () => persist(state);
  await save(); // Persist destination identity before any remote mutation.
  const { restoreUpgradeBackup } = await import('./server-restore');
  return restoreUpgradeBackup({ api, state, artifacts, save, onProgress });
}
