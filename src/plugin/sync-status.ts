import type { Plugin } from 'obsidian';
import type { SyncRuntime } from '../sync/runtime';
import { StatusBarManager } from '../ui/status';

type StatusRuntime = Pick<SyncRuntime, 'isInitialized' | 'getState' | 'getActivityProgress'
  | 'addStateChangeListener' | 'removeStateChangeListener' | 'addProgressListener' | 'removeProgressListener'>;

/** Plugin UI owns its lifetime; runtime events contain no status-bar dependencies. */
export function registerSyncStatus(plugin: Plugin, runtime: StatusRuntime, onClick: () => void): void {
  const status = new StatusBarManager(plugin, false, onClick);
  const render = () => {
    const state = runtime.getState();
    // Initialization failures must remain visible even when there is no engine.
    status.setEnabled(runtime.isInitialized() || state.status === 'error');
    const progress = runtime.getActivityProgress();
    if (progress) {
      status.update({ ...state, status: 'syncing', work: state.work ?? progress.work });
      status.setSyncProgress(progress.current, progress.total);
    } else {
      status.clearSyncProgress();
      status.update(state);
    }
  };
  runtime.addStateChangeListener(render);
  runtime.addProgressListener(render);
  plugin.register(() => {
    runtime.removeStateChangeListener(render);
    runtime.removeProgressListener(render);
    status.destroy();
  });
  render();
}
