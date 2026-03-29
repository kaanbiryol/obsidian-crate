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
}

interface R2ObjectBody {
	body: ReadableStream | null;
	size: number;
	httpMetadata?: R2HttpMetadata;
	customMetadata?: Record<string, string>;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
}

interface R2Bucket {
	get(key: string): Promise<R2ObjectBody | null>;
	put(key: string, value: BodyInit | null, options?: R2PutOptions): Promise<unknown>;
	delete(keys: string | string[]): Promise<void>;
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
