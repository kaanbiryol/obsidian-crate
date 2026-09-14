import type { NotificationRateLimiter } from './rate-limit';
export interface Env {
  CRATE_DEPLOYMENT_FINGERPRINT?: string;
  commitNewFiles?: typeof import('./bulk-new-file-commit').commitNewFiles;
  commitUpload?: import('./staged-upload-dispatch').CommitUpload;
	CRATE_PUBLIC_ORIGIN?: string;
	NOTIFICATION_REQUEST_LIMITER?: NotificationRateLimiter;
	BUCKET: R2Bucket;
	DB: D1Database;
	REMINDER_ALARMS: DurableObjectNamespace;
}
