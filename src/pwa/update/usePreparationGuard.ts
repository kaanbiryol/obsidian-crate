import { useCallback, useRef, useState } from 'react';

/** Counts changes still being prepared for durable storage, which Web Locks and IndexedDB
 * can delay. `isPreparing` answers synchronously, so an update can be refused before the
 * next render; `preparing` is the rendered state. Each feature builds its own commands. */
export function usePreparationGuard() {
	const count = useRef(0);
	const [rendered, setRendered] = useState(0);
	const track = useCallback(async <T>(action: () => Promise<T>): Promise<T> => {
		count.current += 1;
		setRendered(count.current);
		try { return await action(); }
		finally {
			count.current -= 1;
			setRendered(count.current);
		}
	}, []);
	const isPreparing = useCallback(() => count.current > 0, []);
	return { track, isPreparing, preparing: rendered > 0 };
}
