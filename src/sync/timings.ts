import type { SyncWork } from './types';
export const SYNC_PHASES = ['starting', 'recovering', 'server', 'scanning', 'preparing', 'uploading', 'downloading', 'applying', 'saving'] as const;
type Phase = typeof SYNC_PHASES[number];
export interface RequestTimings { count: number; totalMs: number; maxMs: number; serverCount: number; serverMs: number; d1?: { rowsRead: number; rowsWritten: number; reportedRequests: number; completeRequests: number } }
export interface SyncTimings { totalMs: number; phases: Partial<Record<Phase, number>>; requests?: RequestTimings }
export const emptyRequestTimings = (): RequestTimings => ({ count: 0, totalMs: 0, maxMs: 0, serverCount: 0, serverMs: 0 });
const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function normalizeSyncTimings(value: unknown): SyncTimings | undefined {
  if (!value || typeof value !== 'object') return;
  const raw = value as Record<string, unknown>;
  if (!valid(raw.totalMs) || !raw.phases || typeof raw.phases !== 'object') return;
  const phases: SyncTimings['phases'] = {};
  for (const phase of SYNC_PHASES) {
    const n = (raw.phases as Record<string, unknown>)[phase];
    if (valid(n)) phases[phase] = n;
  }
  let requests: RequestTimings | undefined;
  if (raw.requests && typeof raw.requests === 'object') {
    const r = raw.requests as Record<string, unknown>;
    if (['count', 'totalMs', 'maxMs', 'serverCount', 'serverMs'].every(key => valid(r[key]))) {
      requests = { count: r.count as number, totalMs: r.totalMs as number, maxMs: r.maxMs as number, serverCount: r.serverCount as number, serverMs: r.serverMs as number };
      const d1 = r.d1 as Record<string, unknown> | undefined;
      if (d1 && ['rowsRead', 'rowsWritten', 'reportedRequests', 'completeRequests'].every(key => valid(d1[key]) && Number.isSafeInteger(d1[key]))
        && (d1.completeRequests as number) <= (d1.reportedRequests as number) && (d1.reportedRequests as number) <= requests.count) {
        requests.d1 = { rowsRead: d1.rowsRead as number, rowsWritten: d1.rowsWritten as number, reportedRequests: d1.reportedRequests as number, completeRequests: d1.completeRequests as number };
      }
    }
  }
  return { totalMs: raw.totalMs, phases, ...(requests ? { requests } : {}) };
}

export class SyncTimingRecorder {
  private started = 0;
  private since = 0;
  private phase: Phase = 'starting';
  private phases: SyncTimings['phases'] = {};
  private running = false;
  private stopped = 0;
  constructor(private now = () => performance.now()) {}
  start(): void { this.started = this.since = this.now(); this.phase = 'starting'; this.phases = {}; this.running = true; }
  change(work?: SyncWork): void {
    if (!this.running || !work || work.phase === this.phase) return;
    this.flush(); this.phase = work.phase;
  }
  private flush(): void {
    const now = this.now(); this.phases[this.phase] = (this.phases[this.phase] ?? 0) + Math.max(0, now - this.since); this.since = now;
  }
  stop(): void { if (!this.running) return; this.flush(); this.stopped = this.now(); this.running = false; }
  snapshot(): SyncTimings {
    const phases = { ...this.phases };
    if (this.running) phases[this.phase] = (phases[this.phase] ?? 0) + Math.max(0, this.now() - this.since);
    return { totalMs: Math.max(0, (this.running ? this.now() : this.stopped) - this.started), phases };
  }
}
