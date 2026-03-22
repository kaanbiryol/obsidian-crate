export function sanitizePath(path: string): string | null {
	if (!path || typeof path !== 'string') return null;
	if (path.includes('\0')) return null;
	const segments = path.split('/').reduce<string[]>((acc, seg) => {
		if (seg === '..') { acc.pop(); }
		else if (seg !== '.' && seg !== '') { acc.push(seg); }
		return acc;
	}, []);
	if (segments.length === 0) return null;
	return segments.join('/');
}

export const FILES_PREFIX = 'files/';
