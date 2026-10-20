import { fetchWorkerRequest } from './request-handler';

export { CloudSafety } from './standalone/cloud-safety-compat.js';
export { ReminderAlarm } from './coordinator/reminder-alarm';
export default { fetch: (request: Request, env: import('./types').Env, _context?: ExecutionContext) => fetchWorkerRequest(request, env) };
