import type { NotificationRateLimiter } from './admission/rate-limit';
export interface Env {
	/** Local-only native public-network binding. Hosted deployments use strictly public global fetch. */
	READING_FETCH?: { fetch(request: Request): Promise<Response> };
	CRATE_DEPLOYMENT_FINGERPRINT?: string;
	CRATE_PUBLIC_ORIGIN?: string;
	/** Self-hosted only: the largest synced file in bytes. Absent means the default. */
	CRATE_MAX_FILE_BYTES?: string;
	NOTIFICATION_REQUEST_LIMITER?: NotificationRateLimiter;
	BUCKET: R2Bucket;
	DB: D1Database;
	REMINDER_ALARMS: DurableObjectNamespace;
}
