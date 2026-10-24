import { handleCoordinatorRequest } from './coordinator-requests';
import { runCoordinatorAlarm } from './coordinator-alarms';
import { withD1Usage } from '../d1-usage';
import type { Env } from '../types';
import { deliverScheduledReminder, handleReminderScheduleRequest, type ReminderScheduleContext } from '../notifications/reminder-schedule';

export class ReminderAlarm implements DurableObject {
	private stateWrites: Promise<void> = Promise.resolve();
	private deliveries: Promise<void> = Promise.resolve();

	// Serialize short state transitions, but allow a new schedule to arrive while
	// a push request is in flight. Every delivery write checks its schedule token.
	private withStateLock<T>(action: () => Promise<T>): Promise<T> {
		const result = this.stateWrites.then(action);
		this.stateWrites = result.then(() => undefined, () => undefined);
		return result;
	}

	constructor(
		private state: DurableObjectState,
		private env: Pick<Env, 'DB'> & Partial<Env>,
	) {}

	fetch(request: Request): Promise<Response> {
    return withD1Usage(this.env as Env, env => this.fetchMeasured(request, env));
  }

  private fetchMeasured(request: Request, env: Env): Promise<Response> {
    return handleCoordinatorRequest(request, this.state, env,
      action => this.withStateLock(action), () => handleReminderScheduleRequest(request, this.scheduleContext(env)));
  }

	alarm(): Promise<void> {
		// Schedule changes remain responsive while pushes are in flight, but two
		// delivery callbacks cannot send the same occurrence concurrently.
		const result = this.deliveries.then(() => this.handleAlarm());
		this.deliveries = result.catch(() => {});
		return result;
	}

	private async handleAlarm(): Promise<void> {
		if (await runCoordinatorAlarm(this.state, this.env as Env, action => this.withStateLock(action))) return;
		await deliverScheduledReminder(this.scheduleContext(this.env as Env));
	}

	private scheduleContext(env: Env): ReminderScheduleContext {
		return { state: this.state, env, withStateLock: action => this.withStateLock(action) };
	}
}
