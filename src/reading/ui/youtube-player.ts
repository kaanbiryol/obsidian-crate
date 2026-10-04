/** A bundled, frame-scoped bridge: no third-party script executes in the vault/PWA. */
export function connectYoutubePlayer(frame: HTMLIFrameElement, onTime: (seconds: number) => void, onError: () => void) {
	const win = frame.ownerDocument.defaultView!;
	const origin = new URL(frame.src).origin;
	let ready = false, shouldPause = false, shouldPlay = false, pendingSeek: number | undefined;
	const send = (event: string, func?: string, args: unknown[] = []) => frame.contentWindow?.postMessage(JSON.stringify({ event, ...(func ? { func, args } : {}) }), origin);
	const listen = () => send('listening');
	const message = (event: MessageEvent) => {
		if (event.source !== frame.contentWindow || event.origin !== origin || typeof event.data !== 'string' || event.data.length > 65536) return;
		let value: { event?: string; info?: unknown };
		try { value = JSON.parse(event.data) as typeof value; } catch { return; }
		if (!value || typeof value !== 'object') return;
		if (value.event === 'onReady' || value.event === 'initialDelivery') {
			ready = true;
			send('command', 'addEventListener', ['onError']);
			if (pendingSeek !== undefined) { send('command', 'seekTo', [pendingSeek, true]); pendingSeek = undefined; }
			if (shouldPause) send('command', 'pauseVideo');
			else if (shouldPlay) send('command', 'playVideo');
			shouldPlay = false;
		}
		if (value.event === 'onError') onError();
		if ((value.event === 'infoDelivery' || value.event === 'initialDelivery') && value.info && typeof value.info === 'object') {
			const time = (value.info as { currentTime?: unknown }).currentTime;
			if (typeof time === 'number' && Number.isFinite(time) && time >= 0) onTime(time);
		}
	};
	win.addEventListener('message', message); frame.addEventListener('load', listen);
	// Handshake is bounded; all listeners/timers die with this player instance.
	let attempts = 0;
	const timer = win.setInterval(() => { if (ready || ++attempts > 20) win.clearInterval(timer); else listen(); }, 500);
	listen();
	return {
		playAt(seconds: number) {
			if (!Number.isFinite(seconds) || seconds < 0) return;
			shouldPause = false;
			if (ready) { send('command', 'seekTo', [seconds, true]); send('command', 'playVideo'); }
			else { pendingSeek = seconds; shouldPlay = true; }
		},
		pause() { shouldPause = true; shouldPlay = false; send('command', 'pauseVideo'); },
		dispose() { send('command', 'pauseVideo'); win.clearInterval(timer); win.removeEventListener('message', message); frame.removeEventListener('load', listen); },
	};
}
