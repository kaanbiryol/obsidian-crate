export const BROWSER_SETUP_CHOICE_KEY = 'crate-browser-setup-choice';

/**
 * Whether a mobile browser visit lands on the install-or-continue choice.
 * Self-contained so the HTML shell can inline it with `toString()` and skip
 * painting the feature skeleton before app.js replaces it with the choice.
 */
export function browserSetupNeeded(
	search: string, userAgent: string, maxTouchPoints: number, standalone: boolean, choice: string | null,
): boolean {
	const mobile = /iPad|iPhone|iPod|Android/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
	if (standalone || !mobile || choice === 'web') return false;
	const params = new URLSearchParams(search);
	return Boolean(params.get('token') || params.get('browserToken')) || choice === 'choose';
}
