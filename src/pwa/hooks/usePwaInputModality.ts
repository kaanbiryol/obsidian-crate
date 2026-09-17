import { useEffect } from 'react';

/** Native focus can remain after a tap or be restored after a sheet closes. */
export function usePwaInputModality(): void {
	useEffect(() => {
		const root = document.documentElement;
		const setPointerModality = () => { root.dataset.pwaInput = 'pointer'; };
		const setKeyboardModality = (event: KeyboardEvent) => {
			if (event.key === 'Tab') root.dataset.pwaInput = 'keyboard';
		};
		setPointerModality();
		document.addEventListener('pointerdown', setPointerModality, true);
		document.addEventListener('keydown', setKeyboardModality, true);
		return () => {
			document.removeEventListener('pointerdown', setPointerModality, true);
			document.removeEventListener('keydown', setKeyboardModality, true);
			delete root.dataset.pwaInput;
		};
	}, []);
}
