/** maintenance_state key shared by plugin deployments and Worker maintenance. */
export const DEPLOYMENT_FENCE_KEY = 'crate_deployment_fence';

/** maintenance_state key of an unfinished upgrade backup, written by plugin deployments.
 * Worker paths that delete R2 objects wholesale wait while it names a phase in progress. */
export const UPGRADE_PROGRESS_KEY = 'crate_upgrade_backup';
