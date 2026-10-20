import { corsResponse } from '../cors';

/** Folders that need their own encryption scope: reminder, web session and Reading folders. */
export async function handleEncryptionFolders(db: D1Database): Promise<Response> {
	const rows = await db.prepare("SELECT folder_path FROM notification_policy UNION SELECT folder_path FROM auth_tokens WHERE scope = 'reminders' UNION SELECT folder_path FROM web_enrollment_tokens").all<{ folder_path: string | null }>();
	const reading = await db.prepare('SELECT folder_path FROM reading_policy WHERE id=1').first<{ folder_path: string }>();
	return corsResponse({ folders: rows.results.map(row => row.folder_path).filter(Boolean), readingFolder: reading?.folder_path ?? null });
}
