import { useEffect } from 'react';

/** Native focus can remain after a tap or be restored after a sheet closes. */
export function usePwaInputModality(): void {
	useEffect(() => {
		const root = document.documentElement;
		const usePointer = () => { root.dataset.pwaInput = 'pointer'; };
		const useKeyboard = (event: KeyboardEvent) => {
			if (event.key === 'Tab') root.dataset.pwaInput = 'keyboard';
		};
		usePointer();
		document.addEventListener('pointerdown', usePointer, true);
		document.addEventListener('keydown', useKeyboard, true);
		return () => {
			document.removeEventListener('pointerdown', usePointer, true);
			document.removeEventListener('keydown', useKeyboard, true);
			delete root.dataset.pwaInput;
		};
	}, []);
}
