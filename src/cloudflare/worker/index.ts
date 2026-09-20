import { fetchWorkerRequest } from './request-handler';

export { CloudSafety } from './cloud-safety-compat.js';
export { ReminderAlarm } from './notifications';
export default { fetch: (request: Request, env: import('./types').Env, _context?: ExecutionContext) => fetchWorkerRequest(request, env) };
