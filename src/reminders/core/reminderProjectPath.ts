const MAX_PROJECT_PATH_LENGTH = 256;

function containsControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
			return true;
		}
	}
	return false;
}

export function normalizeReminderProjectPath(value: unknown): string | null {
	if (typeof value !== 'string') return null;

	const trimmed = value.trim();
	if (
		!trimmed
		|| trimmed.length > MAX_PROJECT_PATH_LENGTH
		|| trimmed.startsWith('/')
		|| trimmed.endsWith('/')
		|| trimmed.includes('\\')
		|| containsControlCharacters(trimmed)
	) {
		return null;
	}

	const segments = trimmed.split('/');
	if (segments.some((segment) =>
		!segment
		|| segment !== segment.trim()
		|| segment === '.'
		|| segment === '..'
	)) {
		return null;
	}

	return segments.join('/');
}

export function requireReminderProjectPath(value: unknown): string {
	const normalizedProject = normalizeReminderProjectPath(value);
	if (!normalizedProject) {
		throw new Error('Invalid reminder project path');
	}
	return normalizedProject;
}

export function getReminderProjectFilePath(folderPath: string, project: unknown): string {
	const normalizedProject = requireReminderProjectPath(project);
	return `${folderPath}/${normalizedProject}.md`;
}
