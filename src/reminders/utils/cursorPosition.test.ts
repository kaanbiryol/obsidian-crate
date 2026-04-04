import { describe, expect, it } from 'vitest';

import {
	getLogicalCursorOffset,
	getLogicalTextLength,
	resolveLogicalCursorPosition,
} from './cursorPosition';

type FakeNode = {
	nodeType: number;
	nodeName: string;
	textContent: string | null;
	childNodes: FakeNode[];
};

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function element(nodeName: string, ...childNodes: FakeNode[]): FakeNode {
	return {
		nodeType: ELEMENT_NODE,
		nodeName: nodeName.toUpperCase(),
		textContent: null,
		childNodes,
	};
}

function text(content: string): FakeNode {
	return {
		nodeType: TEXT_NODE,
		nodeName: '#text',
		textContent: content,
		childNodes: [],
	};
}

function lineBreak(): FakeNode {
	return element('br');
}

function asNode(node: FakeNode): Node {
	return node as unknown as Node;
}

function resolveOffset(root: FakeNode, position: number): number | null {
	const resolved = resolveLogicalCursorPosition(asNode(root), position);
	if (!resolved) {
		return null;
	}

	if (resolved.type === 'after-node') {
		return getLogicalCursorOffset(asNode(root), resolved.node, 1);
	}

	return getLogicalCursorOffset(asNode(root), resolved.container, resolved.offset);
}

describe('cursorPosition logical offsets', () => {
	it('computes plain text offsets inside a text node', () => {
		const content = text('hello world');
		const root = element('div', content);

		expect(getLogicalCursorOffset(asNode(root), asNode(content), 0)).toBe(0);
		expect(getLogicalCursorOffset(asNode(root), asNode(content), 5)).toBe(5);
		expect(getLogicalCursorOffset(asNode(root), asNode(content), 11)).toBe(11);
	});

	it('counts element child boundaries using the same logical model', () => {
		const first = text('ab');
		const br = lineBreak();
		const third = text('cd');
		const root = element('div', first, br, third);

		expect(getLogicalCursorOffset(asNode(root), asNode(root), 1)).toBe(2);
		expect(getLogicalCursorOffset(asNode(root), asNode(root), 2)).toBe(3);
		expect(getLogicalCursorOffset(asNode(root), asNode(root), 3)).toBe(5);
	});

	it('round-trips offsets across highlighted chip spans', () => {
		const prefix = text('Buy ');
		const chip = element('span', text('#Home'));
		const suffix = text(' today');
		const root = element('div', prefix, chip, suffix);

		for (const position of [0, 1, 4, 5, 9, 10, 15]) {
			expect(resolveOffset(root, position)).toBe(position);
		}
	});

	it('round-trips offsets across line breaks', () => {
		const first = text('ab');
		const br = lineBreak();
		const third = text('cd');
		const root = element('div', first, br, third);

		for (const position of [0, 1, 2, 3, 4, 5]) {
			expect(resolveOffset(root, position)).toBe(position);
		}
	});

	it('clamps out-of-range positions to the logical end', () => {
		const root = element('div', text('hello'), lineBreak(), text('world'));

		expect(getLogicalTextLength(asNode(root))).toBe(11);
		expect(resolveOffset(root, 99)).toBe(11);
	});
});
