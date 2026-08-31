import { moveCursorToEnd } from "../utils/cursorPosition";
import { buildRichTextSegments } from "../utils/richTextRenderer";

export type RichTextFocusOptions = {
  select?: boolean;
};

function appendTextWithLineBreaks(parent: Node, text: string, ownerDocument: Document): void {
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line) {
			parent.appendChild(ownerDocument.createTextNode(line));
		}
		if (index < lines.length - 1) {
			parent.appendChild(ownerDocument.createElement("br"));
		}
	}
}

export function renderRichText(
	element: HTMLDivElement,
	text: string,
	knownProjects?: string[],
): void {
	if (!text) {
		element.replaceChildren();
		return;
	}

	const ownerDocument = element.ownerDocument;
	const fragment = ownerDocument.createDocumentFragment();
	for (const segment of buildRichTextSegments(text, knownProjects)) {
		if (segment.kind === "text") {
			appendTextWithLineBreaks(fragment, segment.text, ownerDocument);
		} else if (segment.kind === "link") {
			const link = ownerDocument.createElement("a");
			link.setAttribute("href", segment.url);
			link.classList.add("reminder-markdown-link");
			link.dataset.markdownLink = "true";
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			appendTextWithLineBreaks(link, segment.text, ownerDocument);
			fragment.appendChild(link);
		} else {
			const chip = ownerDocument.createElement("span");
			chip.classList.add("rich-text-chip", `rich-text-chip-${segment.type}`);
			appendTextWithLineBreaks(chip, segment.text, ownerDocument);
			fragment.appendChild(chip);
		}
	}

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
  if (lastInsertedNode.nodeType === Node.TEXT_NODE) {
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
    selectElementContents(element);
    return;
  }

  moveCursorToEnd(element);
}
