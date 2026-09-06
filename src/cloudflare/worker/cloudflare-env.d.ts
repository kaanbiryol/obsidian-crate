interface D1PreparedStatement {
	bind(...args: unknown[]): D1PreparedStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	run(): Promise<unknown>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

interface D1Database {
	prepare(query: string): D1PreparedStatement;
	batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]>;
	exec(query: string): Promise<unknown>;
}

interface R2HttpMetadata {
	contentType?: string;
}

interface R2PutOptions {
	httpMetadata?: R2HttpMetadata;
	customMetadata?: Record<string, string>;
	onlyIf?: {
		etagMatches?: string;
		etagDoesNotMatch?: string;
	};
}

interface R2ObjectBody {
	key: string;
	etag: string;
	uploaded: Date;
	body: ReadableStream | null;
	size: number;
	httpMetadata?: R2HttpMetadata;
	customMetadata?: Record<string, string>;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
}

interface R2Object {
	key: string;
	etag: string;
	uploaded: Date;
	size: number;
	httpMetadata?: R2HttpMetadata;
	customMetadata?: Record<string, string>;
}

interface R2ListOptions {
	prefix?: string;
	limit?: number;
	cursor?: string;
}

interface R2ListResult {
	objects: R2Object[];
	truncated: boolean;
	cursor?: string;
}

interface R2Bucket {
	get(key: string): Promise<R2ObjectBody | null>;
	head(key: string): Promise<R2Object | null>;
	put(key: string, value: BodyInit | null, options?: R2PutOptions): Promise<R2Object | null>;
	delete(keys: string | string[]): Promise<void>;
	list(options?: R2ListOptions): Promise<R2ListResult>;
}

interface DurableObjectId {
	readonly name?: string;
}

interface DurableObjectStub {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
	put<T = unknown>(key: string, value: T): Promise<void>;
	get<T = unknown>(key: string): Promise<T | undefined>;
	delete(key: string): Promise<boolean>;
	deleteAll(): Promise<void>;
	setAlarm(scheduledTime: number | Date): Promise<void>;
	getAlarm(): Promise<number | null>;
	deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
	readonly storage: DurableObjectStorage;
}

interface DurableObject {
	fetch(request: Request): Promise<Response>;
	alarm?(): Promise<void>;
}

declare module 'cloudflare:workers' {
	export const env: {
		BUCKET: R2Bucket;
		DB: D1Database;
		REMINDER_ALARMS: DurableObjectNamespace;
	};
}

interface ScheduledController {
	readonly cron: string;
	readonly scheduledTime: number;
	noRetry(): void;
}

interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; }
