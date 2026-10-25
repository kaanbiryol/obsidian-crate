import { containsControlCharacters } from '../../platform/validation';
import { DEFAULT_PROJECT } from './constants';

const MAX_PROJECT_PATH_LENGTH = 256;

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

/** A reminder's project, with a missing or empty project shown as the default. */
export function reminderProject(reminder: { project?: string | null }): string {
	return reminder.project || DEFAULT_PROJECT;
}
