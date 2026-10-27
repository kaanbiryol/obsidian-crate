/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';

/** D1 queries count round trips as Cloudflare's per-invocation limit does: one per
 * run/all/first and one per batch. Statements include every statement in a batch. */
interface StorageCost {
	queries: number;
	statements: number;
	rowsRead: number;
	rowsWritten: number;
	r2: Record<'get' | 'head' | 'put' | 'delete' | 'list', number>;
	durableObjectRequests: number;
	alarms: number;
}

export interface StorageCostMeter {
	/** Runs `action`, then (unless `alarms` is false) every alarm it armed that is due now,
	 * and returns their combined cost. */
	measure<T>(action: () => Promise<T>, options?: { alarms?: boolean }): Promise<{ result: T; cost: StorageCost }>;
	/** Runs due alarms without measuring them. */
	settle(): Promise<void>;
	restore(): Promise<void>;
}

type Method = (...args: never[]) => unknown;
const emptyCost = (): StorageCost => ({ queries: 0, statements: 0, rowsRead: 0, rowsWritten: 0,
	r2: { get: 0, head: 0, put: 0, delete: 0, list: 0 }, durableObjectRequests: 0, alarms: 0 });

function billed(result: unknown): { read: number; written: number } {
	const meta = (result as { meta?: { rows_read?: number; rows_written?: number } } | null)?.meta;
	return { read: meta?.rows_read ?? 0, written: meta?.rows_written ?? 0 };
}

/**
 * Meters D1, R2 and Durable Object use in this test isolate, which runs both the
 * public Worker and the bundled coordinator. Alarms are held until `measure`
 * runs them, so a request's follow-up notification and Reading work is included.
 * Call `restore` in `afterAll`.
 */
export async function installStorageCostMeter(): Promise<StorageCostMeter> {
	let active: StorageCost | null = null;
	const restores: Array<() => void> = [];
	function patch<T extends object>(target: T, name: string, replace: (original: Method) => Method): void {
		const original = (target as Record<string, Method>)[name]!;
		(target as Record<string, Method>)[name] = replace(original);
		restores.push(() => { (target as Record<string, Method>)[name] = original; });
	}
	const record = (result: unknown) => {
		if (!active) return;
		const { read, written } = billed(result);
		active.rowsRead += read;
		active.rowsWritten += written;
	};

	const statement = Object.getPrototypeOf(env.DB.prepare('SELECT 1')) as object;
	const all = (statement as Record<string, Method>).all!;
	patch(statement, 'first', () => async function (this: unknown, column?: string) {
		// first() discards billing metadata; all() runs the same statement without adding LIMIT.
		const result = await (all as (this: unknown) => Promise<{ results: Array<Record<string, unknown>> }>).call(this);
		if (active) { active.queries++; active.statements++; }
		record(result);
		const row = result.results[0] ?? null;
		return column ? (row?.[column] ?? null) : row;
	});
	for (const name of ['run', 'all', 'raw']) {
		patch(statement, name, original => async function (this: unknown, ...args: never[]) {
			const result = await (original as (...values: never[]) => Promise<unknown>).apply(this, args);
			if (active) { active.queries++; active.statements++; }
			record(result);
			return result;
		});
	}
	patch(Object.getPrototypeOf(env.DB) as object, 'batch', original => async function (this: unknown, statements: never[]) {
		const results = await (original as (batch: never[]) => Promise<unknown[]>).call(this, statements);
		if (active) { active.queries++; active.statements += statements.length; }
		for (const result of results) record(result);
		return results;
	});

	const bucket = Object.getPrototypeOf(env.BUCKET) as object;
	for (const name of ['get', 'head', 'put', 'delete', 'list'] as const) {
		patch(bucket, name, original => function (this: unknown, ...args: never[]) {
			if (active) active.r2[name] += name === 'delete' && Array.isArray(args[0]) ? (args[0] as unknown[]).length : 1;
			return original.apply(this, args);
		});
	}

	const namespace = Object.getPrototypeOf(env.REMINDER_ALARMS) as object;
	const names = new Set<string>();
	patch(namespace, 'idFromName', original => function (this: unknown, ...args: never[]) {
		names.add(String(args[0]));
		return original.apply(this, args);
	});
	const getStub = (namespace as Record<string, Method>).get! as (this: DurableObjectNamespace, id: DurableObjectId) => DurableObjectStub;
	patch(namespace, 'get', () => function (this: DurableObjectNamespace, id: DurableObjectId) {
		const stub = getStub.call(this, id);
		const metered: DurableObjectStub = { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
			if (active) active.durableObjectRequests++;
			return stub.fetch(input, init);
		} };
		return metered;
	});
	const stub = (name: string) => getStub.call(env.REMINDER_ALARMS, env.REMINDER_ALARMS.idFromName(name));

	// Alarms are stored far in the future and run by `drain`; getAlarm reports the requested
	// time, and runDurableObjectAlarm clears it through deleteAlarm before the handler runs.
	const requested = new Map<object, number>();
	const storage = await runInDurableObject(stub('__test__/storage-cost-probe'), (_instance, state) => Object.getPrototypeOf(state.storage) as object);
	names.delete('__test__/storage-cost-probe');
	patch(storage, 'setAlarm', original => function (this: object, time: number | Date) {
		requested.set(this, Number(time));
		return (original as (at: number) => Promise<void>).call(this, Date.now() + 30 * 86_400_000);
	});
	patch(storage, 'getAlarm', () => async function (this: object) { return requested.get(this) ?? null; });
	patch(storage, 'deleteAlarm', original => function (this: object) {
		requested.delete(this);
		return (original as () => Promise<void>).call(this);
	});

	async function drain(): Promise<void> {
		for (let round = 0; round < 1_000; round++) {
			let ran = false;
			for (const name of [...names]) {
				const target = stub(name);
				const due = await runInDurableObject(target, (_instance, state) => requested.get(state.storage) ?? null);
				if (due === null || due > Date.now() + 5_000) continue;
				if (active) active.alarms++;
				if (!await runDurableObjectAlarm(target)) throw new Error(`No alarm was scheduled for ${name}`);
				ran = true;
			}
			if (!ran) return;
		}
		throw new Error('Alarms kept rescheduling themselves');
	}

	return {
		async measure(action, options) {
			const cost = emptyCost();
			active = cost;
			try {
				const result = await action();
				if (options?.alarms !== false) await drain();
				return { result, cost };
			} finally { active = null; }
		},
		settle: drain,
		async restore() {
			for (const undo of restores.reverse()) undo();
			restores.length = 0;
		},
	};
}
