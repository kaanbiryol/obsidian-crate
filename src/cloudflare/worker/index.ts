import { fetchWorkerRequest } from './request-handler';

export { ReminderAlarm } from './coordinator/reminder-alarm';
export default { fetch: (request: Request, env: import('./types').Env, _context?: ExecutionContext) => fetchWorkerRequest(request, env) };
