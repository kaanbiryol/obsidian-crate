import type { EditorState } from '@codemirror/state';
import { editorInfoField, TFile } from 'obsidian';

export function getEditorFile(state: EditorState): TFile | undefined {
	const file = state.field(editorInfoField)?.file;
	return file instanceof TFile ? file : undefined;
}
