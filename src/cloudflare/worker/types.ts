export interface Env {
	BUCKET: R2Bucket;
	DB: D1Database | null;
	AUTH_TOKEN: string;
	REMINDER_ALARMS: DurableObjectNamespace;
	SETUP: DurableObjectNamespace;
}
