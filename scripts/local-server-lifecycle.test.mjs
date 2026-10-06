import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeLocalServerResources } from '../packages/server/src/local-server-lifecycle.mjs';

test('shutdown attempts later resources after any cleanup failure', async t => {
	for (const failed of ['readiness', 'control', 'tunnel', 'server', 'runtime']) {
		await t.test(failed, async () => {
			const calls = [];
			const failure = new Error(`${failed} failed`);
			const close = name => {
				calls.push(name);
				if (name === failed) throw failure;
			};
			await assert.rejects(closeLocalServerResources({
				readiness: { close: async () => close('readiness') },
				control: { close: async () => close('control') },
				tunnel: { stop: async () => close('tunnel') },
				server: { close: callback => { calls.push('server'); callback(failed === 'server' ? failure : undefined); } },
				runtime: { close: async () => close('runtime') },
			}), error => {
				assert.ok(error instanceof AggregateError);
				assert.deepEqual(error.errors, [failure]);
				assert.match(error.message, new RegExp(`${failed} failed`));
				return true;
			});
			assert.deepEqual(calls, ['readiness', 'control', 'tunnel', 'server', 'runtime']);
		});
	}
});

test('shutdown preserves the startup failure alongside every cleanup failure', async () => {
	const startup = new Error('Could not connect the tunnel');
	const control = new Error('Could not remove the control file');
	const storage = new Error('Could not dispose the runtime');
	await assert.rejects(closeLocalServerResources({
		control: { close() { throw control; } },
		runtime: { async close() { throw storage; } },
	}, startup), error => {
		assert.equal(error.cause, startup);
		assert.deepEqual(error.errors, [startup, control, storage]);
		assert.match(error.message, /^Could not connect the tunnel\nPairing control:/);
		assert.match(error.message, /Storage runtime: Could not dispose the runtime/);
		return true;
	});
});

test('shutdown waits for HTTP requests before disposing storage and clears the deadline', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const started = Promise.withResolvers();
	let finishHttp, disposed = false, forced = false;
	const closing = closeLocalServerResources({
		server: {
			close(callback) { finishHttp = callback; started.resolve(); },
			closeAllConnections() { forced = true; },
		},
		runtime: { close() { disposed = true; } },
	});
	await started.promise;
	assert.equal(disposed, false);
	finishHttp();
	await closing;
	t.mock.timers.tick(5000);
	assert.equal(disposed, true);
	assert.equal(forced, false);
});

test('shutdown forces lingering HTTP connections closed after the drain deadline', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const started = Promise.withResolvers();
	let finishHttp, forced = 0, disposed = false;
	const closing = closeLocalServerResources({
		server: {
			close(callback) { finishHttp = callback; started.resolve(); },
			closeAllConnections() { forced++; finishHttp(); },
		},
		runtime: { close() { disposed = true; } },
	});
	await started.promise;
	t.mock.timers.tick(4999);
	assert.equal(forced, 0);
	assert.equal(disposed, false);
	t.mock.timers.tick(1);
	await closing;
	assert.equal(forced, 1);
	assert.equal(disposed, true);
});

test('shutdown accepts partial startup and an already stopped HTTP listener', async () => {
	await closeLocalServerResources({});
	let disposed = false;
	await closeLocalServerResources({
		server: { close(callback) { callback(Object.assign(new Error('Stopped'), { code: 'ERR_SERVER_NOT_RUNNING' })); } },
		runtime: { close() { disposed = true; } },
	});
	assert.equal(disposed, true);
});
