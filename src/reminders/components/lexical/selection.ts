import { $createRangeSelection, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, $setSelection, type LexicalNode, type PointType } from 'lexical';
import { $isLinkNode } from '@lexical/link';

function $size(node: LexicalNode, markdown: boolean): number {
  return node.getTextContentSize() + (markdown && $isLinkNode(node) ? node.getURL().length + 4 : 0);
}

function $offset(point: PointType, markdown: boolean): number {
  let offset = point.type === 'text' ? point.offset : 0;
  let node = point.getNode();
  if (point.type === 'element' && $isElementNode(node)) {
    offset = node.getChildren().slice(0, point.offset).reduce((sum, child) => sum + $size(child, markdown), 0);
  }
  while (node.getParent()) {
    offset += node.getPreviousSiblings().reduce((sum, sibling) => sum + $size(sibling, markdown), 0);
    node = node.getParentOrThrow();
    if (markdown && $isLinkNode(node)) offset++; // opening [ before the label
  }
  return offset;
}

export function $selectionOffsets(markdown = false): { anchor: number; focus: number } | null {
  const selection = $getSelection();
  return $isRangeSelection(selection) ? { anchor: $offset(selection.anchor, markdown), focus: $offset(selection.focus, markdown) } : null;
}

export function $restoreOffsets(offsets: { anchor: number; focus: number } | null): void {
  if (!offsets) { $setSelection(null); return; }
  const selection = $createRangeSelection();
  const resolve = (point: PointType, requested: number) => {
    let remaining = Math.max(0, requested);
    const visit = (node: LexicalNode): boolean => {
      if ($isTextNode(node)) {
        if (remaining <= node.getTextContentSize()) {
          point.set(node.getKey(), remaining, 'text');
          return true;
        }
        remaining -= node.getTextContentSize();
      } else if ($isElementNode(node)) {
        for (const child of node.getChildren()) if (visit(child)) return true;
      } else {
        if (remaining === 0) {
          point.set(node.getParentOrThrow().getKey(), node.getIndexWithinParent(), 'element');
          return true;
        }
        remaining -= node.getTextContentSize();
      }
      return false;
    };
    if (!visit($getRoot())) {
      const paragraph = $getRoot().getLastChild();
      if ($isElementNode(paragraph)) point.set(paragraph.getKey(), paragraph.getChildrenSize(), 'element');
      else point.set($getRoot().getKey(), 0, 'element');
    }
  };
  resolve(selection.anchor, offsets.anchor);
  resolve(selection.focus, offsets.focus);
  $setSelection(selection);
}
