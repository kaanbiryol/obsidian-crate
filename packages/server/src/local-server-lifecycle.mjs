async function closeHttpServer(server) {
	const deadline = setTimeout(() => server.closeAllConnections(), 5000);
	try {
		await new Promise((resolve, reject) => server.close(error => {
			if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
			else resolve();
		}));
	} finally { clearTimeout(deadline); }
}

/** Stop incoming work before disposing storage. One failed cleanup must not skip
 * the remaining resources; the runtime still owns disposal and safe unlocking. */
export async function closeLocalServerResources({ readiness, control, tunnel, server, runtime }, startupError) {
	const errors = [];
	const messages = [];
	for (const [name, close] of [
		['Readiness checks', () => readiness?.close()],
		['Pairing control', () => control?.close()],
		['Tunnel', () => tunnel?.stop()],
		['HTTP server', () => server && closeHttpServer(server)],
		['Storage runtime', () => runtime?.close()],
	]) {
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
