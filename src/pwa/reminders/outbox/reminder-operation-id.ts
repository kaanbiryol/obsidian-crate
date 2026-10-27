import { createReminderOperationId } from '@/protocol/reminder-operation';
import { requireCompatibleServer } from '../../connection/server-compatibility';
import { capturePwaSession } from '../../connection/session-generation';

const OPERATION_DAY_KEY = 'crate-reminder-operation-day';
/** An older day is always accepted: the server allows the issued day and the
 * next 179, so reusing it only shortens the retry window. */
const OPERATION_DAY_REUSE_MS = 7 * 86_400_000;

/** The last server day confirmed within the reuse window. The device clock only
 * ages the stored day; it never chooses one. A clock set back expires it. */
function confirmedOperationDay(): number | undefined {
	try {
		const stored = JSON.parse(localStorage.getItem(OPERATION_DAY_KEY) ?? 'null') as { day?: unknown; fetchedAt?: unknown } | null;
		const age = Date.now() - Number(stored?.fetchedAt);
		return typeof stored?.day === 'number' && Number.isSafeInteger(stored.day) && age >= 0 && age < OPERATION_DAY_REUSE_MS ? stored.day : undefined;
	} catch { return undefined; }
}

async function fetchOperationDay(): Promise<number> {
	const info = await requireCompatibleServer();
	if (info.reminderOperationDay === undefined) throw new Error('Update the Crate server before saving this change. Your draft is kept on this device.');
	try { localStorage.setItem(OPERATION_DAY_KEY, JSON.stringify({ day: info.reminderOperationDay, fetchedAt: Date.now() })); }
	catch { /* The next change fetches the day again. */ }
	return info.reminderOperationDay;
}

/** Opening an editor refreshes the day in the background, so its save need not wait. */
export function refreshReminderOperationDay(): void {
	void fetchOperationDay().catch(() => { /* A save without a recent day fetches it. */ });
}

/** Issue new commands from the server's day; retries keep their exact IDs. The
 * protocol check still runs at dispatch, after the change is durably queued. */
export async function newReminderOperationId(): Promise<string> {
	const current = capturePwaSession();
	const day = confirmedOperationDay() ?? await fetchOperationDay();
	if (!current()) throw new Error('Session changed. Reopen Crate before saving.');
	return createReminderOperationId(day);
}
