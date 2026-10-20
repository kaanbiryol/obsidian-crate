import { describe, expect, it, vi } from 'vitest';
import { getEditorSelectionRange } from './editorSelection';

function editorSelection() {
	const text = {} as Node;
	const host = {} as Node;
	const shadowRoot = { host };
	const inside = { startContainer: text, startOffset: 2, endContainer: text, endOffset: 5 };
	const outside = { startContainer: host, startOffset: 0, endContainer: host, endOffset: 1 };
	const selection = {
		rangeCount: 1,
		getRangeAt: vi.fn(() => outside),
		getComposedRanges: vi.fn((_options: unknown) => [inside]),
	};
	const range = {
		...outside,
		setStart(container: Node, offset: number) { this.startContainer = container; this.startOffset = offset; },
		setEnd(container: Node, offset: number) { this.endContainer = container; this.endOffset = offset; },
	};
	const createRange = vi.fn(() => range);
	const element = {
		ownerDocument: { getSelection: () => selection, createRange },
		getRootNode: () => shadowRoot,
		contains: (node: Node) => node === text,
	} as unknown as HTMLElement;
	return { element, selection, shadowRoot, inside, outside, createRange };
}

describe('editor selection across shadow boundaries', () => {
	it('recovers the actual selected text when the document range points to the host', () => {
		const { element, selection, shadowRoot, inside } = editorSelection();
		expect(getEditorSelectionRange(element)).toMatchObject(inside);
		expect(selection.getComposedRanges).toHaveBeenCalledWith({ shadowRoots: [shadowRoot] });
	});

	it('supports Safari versions that accept a shadow root directly', () => {
		const { element, selection, shadowRoot, inside } = editorSelection();
		selection.getComposedRanges.mockImplementation(options => {
			if (options !== shadowRoot) throw new TypeError('Expected a ShadowRoot');
			return [inside];
		});
		expect(getEditorSelectionRange(element)).toMatchObject(inside);
	});

	it('uses an ordinary in-editor range when the newer API is unavailable', () => {
		const { element, selection, inside } = editorSelection();
		selection.getRangeAt.mockReturnValue(inside);
		selection.getComposedRanges.mockImplementation(() => { throw new Error('Unsupported'); });
		expect(getEditorSelectionRange(element)).toBe(inside);
		expect(selection.getComposedRanges).not.toHaveBeenCalled();
	});

	it('does not expose a range that would replace content outside the editor', () => {
		const { element, selection, inside, outside, createRange } = editorSelection();
		selection.getComposedRanges.mockReturnValue([{ ...inside, endContainer: outside.endContainer }]);
		expect(getEditorSelectionRange(element)).toBeNull();
		expect(createRange).not.toHaveBeenCalled();
	});

	it('leaves an unresolved selection alone if neither API form is supported', () => {
		const { element, selection } = editorSelection();
		selection.getComposedRanges.mockImplementation(() => { throw new TypeError('Unsupported'); });
		expect(getEditorSelectionRange(element)).toBeNull();
	});
});
