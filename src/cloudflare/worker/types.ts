export interface Env {
	BUCKET: R2Bucket;
	DB: D1Database;
	REMINDER_ALARMS: DurableObjectNamespace;
}
