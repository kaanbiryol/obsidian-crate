/**
 * Roles are named instances of the `ReminderAlarm` Durable Object class, whose
 * class name deployment discovery pins. The coordinator serializes sync writes,
 * imports, checkpoints, Reading publication and maintenance.
 */
const COORDINATOR_NAME = '__crate__/projection';
const NOTIFICATION_DISPATCHER_NAME = '__crate__/notification-dispatch';

type AlarmBinding = { REMINDER_ALARMS: DurableObjectNamespace };

export function coordinatorStub(env: AlarmBinding): DurableObjectStub {
	return env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName(COORDINATOR_NAME));
}

export function notificationDispatcherStub(env: AlarmBinding): DurableObjectStub {
	return env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName(NOTIFICATION_DISPATCHER_NAME));
}
