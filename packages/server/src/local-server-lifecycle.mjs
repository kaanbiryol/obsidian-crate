/**
 * What `closeLocalServerResources` stops, in this order. Each one is optional.
 * @typedef {object} LocalServerResources
 * @property {{ close(): Promise<void> }} [readiness]
 * @property {{ close(): Promise<void> }} [control]
 * @property {{ stop(): Promise<void> }} [tunnel]
 * @property {import('node:http').Server} [server]
 * @property {{ close(): Promise<void> } | null} [runtime]
 */

/**
 * The resources a CLI command opens. A Quick Tunnel server closes its own set.
 * @typedef {LocalServerResources & { quickServer?: { close(): Promise<void> } }} CommandResources
 */

/** @param {import('node:http').Server} server */
async function closeHttpServer(server) {
	const deadline = setTimeout(() => server.closeAllConnections(), 5000);
	try {
		await /** @type {Promise<void>} */ (new Promise((resolve, reject) => server.close((/** @type {NodeJS.ErrnoException | undefined} */ error) => {
			if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
			else resolve();
		})));
	} finally { clearTimeout(deadline); }
}

/** Stop incoming work before disposing storage. One failed cleanup must not skip
 * the remaining resources; the runtime still owns disposal and safe unlocking.
 * @param {LocalServerResources} resources
 * @param {unknown} [startupError] */
export async function closeLocalServerResources({ readiness, control, tunnel, server, runtime }, startupError) {
	const errors = [];
	const messages = [];
	for (const [name, close] of /** @type {[string, () => unknown][]} */ ([
		['Readiness checks', () => readiness?.close()],
		['Pairing control', () => control?.close()],
		['Tunnel', () => tunnel?.stop()],
		['HTTP server', () => server && closeHttpServer(server)],
		['Storage runtime', () => runtime?.close()],
	])) {
		try { await close(); }
		catch (error) {
			errors.push(error);
			messages.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (errors.length) {
		if (startupError !== undefined) {
			errors.unshift(startupError);
			messages.unshift(startupError instanceof Error ? startupError.message : String(startupError));
		}
		throw new AggregateError(errors, messages.join('\n'), { cause: startupError });
	}
}
