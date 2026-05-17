import { moveCursorToEnd } from "../utils/cursorPosition";

export type RichTextFocusOptions = {
  select?: boolean;
};

export function renderRichText(element: HTMLDivElement, html: string): void {
  if (!html) {
    element.replaceChildren();
    return;
  }

  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  const fragment = range.createContextualFragment(html);
  element.replaceChildren(fragment);
}

export function insertPlainTextAtSelection(text: string): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const fragment = document.createDocumentFragment();
  let lastInsertedNode: Node | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line) {
      const textNode = document.createTextNode(line);
      fragment.append(textNode);
      lastInsertedNode = textNode;
    }

    if (index < lines.length - 1) {
      const lineBreak = document.createElement("br");
      fragment.append(lineBreak);
      lastInsertedNode = lineBreak;
    }
  }

  if (!lastInsertedNode) {
    return;
  }

  range.insertNode(fragment);

  const nextRange = document.createRange();
  if (lastInsertedNode instanceof Text) {
    nextRange.setStart(lastInsertedNode, lastInsertedNode.textContent?.length ?? 0);
  } else {
    nextRange.setStartAfter(lastInsertedNode);
  }
  nextRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(nextRange);
}

export function selectElementContents(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function focusRichTextElement(element: HTMLDivElement, options: RichTextFocusOptions = {}): void {
  element.focus({ preventScroll: true });
  if (options.select) {
    requestAnimationFrame(() => {
      selectElementContents(element);
    });
    return;
  }

  const moveActiveCursorToEnd = () => {
    if (document.activeElement !== element) {
      return;
    }

    moveCursorToEnd(element);
  };

  moveActiveCursorToEnd();
  requestAnimationFrame(moveActiveCursorToEnd);
  for (const delay of [50, 140, 320, 650]) {
    window.setTimeout(moveActiveCursorToEnd, delay);
  }
}
