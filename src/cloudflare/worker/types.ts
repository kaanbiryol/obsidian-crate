export interface Env {
	BUCKET: R2Bucket;
	DB: D1Database | null;
	AUTH_TOKEN: string;
	CF_ACCOUNT_ID: string;
	CF_WORKER_NAME: string;
	CF_BUCKET_NAME: string;
	CF_DATABASE_ID: string;
	REMINDER_ALARMS: DurableObjectNamespace;
}
