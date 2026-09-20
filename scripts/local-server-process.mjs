import { spawn } from 'node:child_process';

// Never let unrelated cloudflared environment settings override the saved
// tunnel, credentials, DNS overwrite policy, or ingress configuration.
export function tunnelEnvironment() {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TUNNEL_') && key !== 'NO_AUTOUPDATE'));
}

export function startProcess(command, args, { signal, env = process.env, stdio = 'inherit', onOutput } = {}) {
	signal?.throwIfAborted();
	const child = spawn(command, args, { stdio, env, windowsHide: true });
	if (onOutput) {
		child.stdout?.on('data', chunk => onOutput(chunk.toString()));
		child.stderr?.on('data', chunk => onOutput(chunk.toString()));
	}
	let settled = false;
	let timer;
	const stop = () => {
		if (settled || timer) return;
		child.kill('SIGTERM');
		timer = setTimeout(() => child.kill('SIGKILL'), 5000);
		timer.unref();
	};
	const exited = new Promise(resolve => {
		const finish = result => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', stop);
			resolve(result);
		};
		child.once('error', error => finish({ error }));
		child.once('exit', (code, signal) => finish({ code, signal }));
	});
	signal?.addEventListener('abort', stop, { once: true });
	return { exited, async stop() { stop(); await exited; } };
}

export async function runProcess(command, args, options) {
	const result = await startProcess(command, args, options).exited;
	options?.signal?.throwIfAborted();
	if (result.error) throw result.error;
	if (result.code !== 0) throw new Error(`${command} failed (${result.signal ?? result.code}). See its output above, then retry the command.`);
}
