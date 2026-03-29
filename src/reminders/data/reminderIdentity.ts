import { generateContentHash } from '@/reminders/utils/checkboxParser';

export function generateReminderId(filePath: string, content: string): string {
	const contentHash = generateContentHash(content);
	const fileHash = generateContentHash(filePath);
	return `${fileHash}-${contentHash}`;
}
