import { AUTH_TOKEN_KEY } from './config';

let generation = 0;
export function invalidatePwaSession(): void { generation += 1; }
export function capturePwaSession(): () => boolean {
	const captured = generation;
	try {
		const token = typeof localStorage === 'undefined' ? null : localStorage.getItem(AUTH_TOKEN_KEY);
		return () => {
			try { return captured === generation && (typeof localStorage === 'undefined' || localStorage.getItem(AUTH_TOKEN_KEY) === token); }
			catch { return false; }
		};
	} catch { return () => false; }
}
