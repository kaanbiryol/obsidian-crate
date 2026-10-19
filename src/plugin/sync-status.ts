import type { Plugin } from 'obsidian';
import type { SyncRuntime } from '../sync/runtime/runtime';
import { StatusBarManager } from '../ui/status';

type StatusRuntime = Pick<SyncRuntime, 'isInitialized' | 'getState' | 'getActivityProgress'
  | 'addStateChangeListener' | 'removeStateChangeListener' | 'addProgressListener' | 'removeProgressListener'>;

/** Plugin UI owns its lifetime; runtime events contain no status-bar dependencies. */
export function registerSyncStatus(plugin: Plugin, runtime: StatusRuntime, onClick: () => void): void {
  const status = new StatusBarManager(plugin, false, onClick);
  const render = () => {
    const state = runtime.getState();
    // Initialization failures must remain visible even when there is no engine.
    status.setEnabled(runtime.isInitialized() || state.initializing === true || state.status === 'error');
    const progress = runtime.getActivityProgress();
    if (progress) {
      status.setSyncProgress(progress.current, progress.total);
      status.update({ ...state, status: 'syncing', work: state.work ?? progress.work });
    } else {
      status.clearSyncProgress();
      status.update(state);
    }
  };
  // A file's state change and progress tick arrive together; render them once.
  let scheduled = false, disposed = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!disposed) render(); });
  };
  runtime.addStateChangeListener(schedule);
  runtime.addProgressListener(schedule);
  plugin.register(() => {
    disposed = true;
    runtime.removeStateChangeListener(schedule);
    runtime.removeProgressListener(schedule);
    status.destroy();
  });
  render();
}
