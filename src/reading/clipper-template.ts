import { READING_IMPORT_MARKER } from './core/model';
import { validateReadingFolder } from './settings';

/** Obsidian Web Clipper's portable template export schema (0.1.0). */
export function createReadingClipperTemplate(folder: string): string {
	return JSON.stringify({
		schemaVersion: '0.1.0', name: 'Crate Reading', behavior: 'create',
		noteNameFormat: '{{title}}', path: validateReadingFolder(folder),
		noteContentFormat: '{{content}}',
		properties: [
			{ name: 'crate_reading_import', value: READING_IMPORT_MARKER, type: 'text' },
			{ name: 'title', value: '{{title}}', type: 'text' },
			{ name: 'source_url', value: '{{url}}', type: 'text' },
			// Text preserves the offset; Clipper's datetime property can reformat it.
			{ name: 'saved_at', value: '{{date|date:"YYYY-MM-DDTHH:mm:ssZ"}}', type: 'text' },
			{ name: 'author', value: '{{author}}', type: 'text' },
		], triggers: [],
	}, null, '\t');
}
