import type { CloudflareDeploymentMetadata } from '../deployment-types';
import type { BackupSource } from './archive';
export interface ServerRestoreState {
  id: string; source: BackupSource; prefix: string; archiveHash: string; fingerprint: string;
  restoredAt: number; phase: 'copying' | 'publishing' | 'complete'; target: CloudflareDeploymentMetadata;
}
export function validRestoreState(value: unknown): value is ServerRestoreState {
  if (!value || typeof value !== 'object') return false;
  const state = value as ServerRestoreState;
  const target = state.target, source = state.source;
  return typeof state.id === 'string' && /^[a-f0-9]{16}$/.test(state.id)
    && !!source && /^[a-f0-9]{32}$/i.test(source.account) && /^[a-f0-9-]{36}$/i.test(source.database)
    && typeof source.bucket === 'string' && !!source.bucket
    && /^__crate__\/backups\/schema-upgrade-[a-f0-9-]{36}$/.test(state.prefix)
    && /^[a-f0-9]{64}$/.test(state.archiveHash) && /^[a-f0-9]{64}$/.test(state.fingerprint)
    && Number.isSafeInteger(state.restoredAt) && state.restoredAt > 0
    && ['copying', 'publishing', 'complete'].includes(state.phase)
    && !!target && target.deploymentId === state.id && !target.reset && target.accountId === source.account && target.workerName === `crate-${state.id}`
    && target.r2BucketName === target.workerName && target.d1DatabaseName === target.workerName
    && target.r2BucketName !== source.bucket && target.d1DatabaseId !== source.database
    && (state.phase === 'copying' || typeof target.d1DatabaseId === 'string')
    && (state.phase !== 'complete' || typeof target.workersSubdomain === 'string' && /^[a-z0-9-]+$/.test(target.workersSubdomain))
    && (target.d1DatabaseId === null || /^[a-f0-9-]{36}$/i.test(target.d1DatabaseId));
}
