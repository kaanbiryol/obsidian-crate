import { expect, it } from 'vitest';
import { addReminderScope, createVaultKeyBundle } from '../../../encryption/key-bundle';
import { createReminderProjection } from '../../../encryption/reminder-projection';
import { ENCRYPTED_NOTIFICATION_PREFIX } from '../../../encryption/notification-format';
import { createDeclarativePushPayload } from './push';
import { MAX_PUSH_PAYLOAD_BYTES } from './payload-budget';

it('sends encrypted display text with a generic mutable fallback within the Web Push budget', async () => {
	const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
	const bytes = new TextEncoder().encode(`- [ ] Private ${'🌻'.repeat(500)} @2099-01-02T10:00:00.000Z <!-- crate-id:r1 -->`).buffer;
	const projection = await createReminderProjection(bundle, 'Reminders/Personal.md', bytes);
	const notice = projection!.reminders[0]!.notification;
	const push = createDeclarativePushPayload({ title: ENCRYPTED_NOTIFICATION_PREFIX + JSON.stringify(notice), body: '', reminderId: 'r1' }, 'https://crate.test');
	expect(push.notification).toMatchObject({ mutable: true, title: 'Crate reminder', data: { encrypted: notice } });
	expect(JSON.stringify(push)).not.toContain('Private');
	expect(JSON.stringify(push)).not.toContain('Personal');
	expect(new TextEncoder().encode(JSON.stringify(push)).length).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
});
