import { useEffect, useRef, useState } from 'react';

/** Whether the browser reports a network connection, following its `online` and
 * `offline` events. `onChange` runs on every such event, including a repeated one. */
export function useOnlineStatus(onChange?: () => void): boolean {
	const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
	const changed = useRef(onChange);
	changed.current = onChange;
	useEffect(() => {
		const update = (event: Event) => { setOnline(event.type === 'online'); changed.current?.(); };
		window.addEventListener('online', update); window.addEventListener('offline', update);
		return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
	}, []);
	return online;
}
