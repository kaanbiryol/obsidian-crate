import { createReminderOperationId } from '@/protocol/reminder-operation';
import { requireCompatibleServer } from './server-compatibility';
import { capturePwaSession } from './session-generation';

/** Issue new commands using the server clock; retries keep their exact IDs. */
export async function newReminderOperationId(): Promise<string> {
	const current = capturePwaSession();
	const info = await requireCompatibleServer();
	if (!current()) throw new Error('Session changed. Reopen Crate before saving.');
	if (info.reminderOperationDay === undefined) throw new Error('Update the Crate server before saving this change. Your draft is kept on this device.');
	return createReminderOperationId(info.reminderOperationDay);
}
