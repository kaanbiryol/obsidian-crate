import { moveCursorToEnd } from "../utils/cursorPosition";
import { buildRichTextSegments, getRichTextChipParts } from "../utils/richTextRenderer";

const ELEMENT_NODE_TYPE = typeof Node !== "undefined" ? Node.ELEMENT_NODE : 1;

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
			const { marker, label } = getRichTextChipParts(segment.type, segment.text);
			if (marker) {
				const markerElement = ownerDocument.createElement("span");
				markerElement.classList.add("rich-text-chip-marker");
				markerElement.textContent = marker;
				chip.appendChild(markerElement);
			}
			appendTextWithLineBreaks(chip, label, ownerDocument);
			fragment.appendChild(chip);
		}
	}

	element.replaceChildren(fragment);
}

const ACTIVE_CHIP_CLASS = "is-cursor-active";

export function clearActiveRichTextChip(element: HTMLDivElement): void {
	element.querySelectorAll(`.rich-text-chip.${ACTIVE_CHIP_CLASS}`).forEach((chip) => {
		chip.classList.remove(ACTIVE_CHIP_CLASS);
	});
}

export function isRichTextRenderingCurrent(
	element: HTMLDivElement,
	expectedHtml: string,
): boolean {
	if (element.innerHTML === expectedHtml) {
		return true;
	}

	const activeChips = Array.from(
		element.querySelectorAll(`.rich-text-chip.${ACTIVE_CHIP_CLASS}`),
	);
	if (!activeChips.length) {
		return false;
	}

	// Cursor-only presentation must not make the editor rebuild its content.
	// Removing and restoring the class synchronously avoids a visible style change.
	activeChips.forEach((chip) => chip.classList.remove(ACTIVE_CHIP_CLASS));
	const isCurrent = element.innerHTML === expectedHtml;
	activeChips.forEach((chip) => chip.classList.add(ACTIVE_CHIP_CLASS));
	return isCurrent;
}

export function syncActiveRichTextChip(element: HTMLDivElement): void {
	clearActiveRichTextChip(element);

	const root = element.getRootNode() as Document | ShadowRoot;
	if (root.activeElement !== element) {
		return;
	}

	const focusNode = element.ownerDocument.getSelection()?.focusNode ?? null;
	if (!focusNode || !element.contains(focusNode)) {
		return;
	}

	const focusElement = focusNode.nodeType === ELEMENT_NODE_TYPE
		? focusNode as Element
		: focusNode.parentElement;
	const activeChip = focusElement?.closest(".rich-text-chip-project, .rich-text-chip-priority") ?? null;
	if (activeChip && element.contains(activeChip)) {
		activeChip.classList.add(ACTIVE_CHIP_CLASS);
	}
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
