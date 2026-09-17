import {
  $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot,
  $isElementNode, $isTextNode, type LexicalNode, type TextNode,
} from 'lexical';
import { $isLinkNode } from '@lexical/link';
import { ReminderLinkNode } from './ReminderLinkNode';
import { buildRichTextSegments } from '@/reminders/utils/richTextRenderer';
import { findActiveReminderMatches } from '@/reminders/utils/reminderEditorParsing';
import { ReminderTextNode } from './ReminderTextNode';

function $serialize(node: LexicalNode): string {
  if ($isLinkNode(node)) return `[${node.getTextContent()}](${node.getURL()})`;
  if ($isElementNode(node)) return node.getChildren().map($serialize).join('');
  return node.getTextContent();
}

/** The application boundary stays Markdown text; Lexical JSON never leaves the editor. */
export function $readReminder(): string {
  return $getRoot().getChildren().map($serialize).join('\n');
}

export function $writeReminder(value: string, projects: string[]): void {
  const paragraph = $createParagraphNode();
  for (const segment of buildRichTextSegments(value, projects)) {
    if (segment.kind === 'link') {
      paragraph.append(new ReminderLinkNode(segment.url, { target: '_blank', rel: 'noopener noreferrer' })
        .append($createTextNode(segment.text)));
    } else {
      segment.text.split('\n').forEach((line, index) => {
        if (index) paragraph.append($createLineBreakNode());
        if (line) paragraph.append(new ReminderTextNode(line, segment.kind === 'chip' ? segment.type : 'text'));
      });
    }
  }
  $getRoot().clear().append(paragraph);
}

/** Split nodes through Lexical so it remaps both selection endpoints itself. */
function $decorateText(node: TextNode, offset: number, matches: ReturnType<typeof findActiveReminderMatches>) {
  const length = node.getTextContentSize();
  const boundaries = new Set<number>();
  for (const match of matches) {
    for (const boundary of [match.index, match.index + match.length]) {
      if (boundary > offset && boundary < offset + length) boundaries.add(boundary - offset);
    }
  }
  for (const part of boundaries.size ? node.splitText(...[...boundaries].sort((a, b) => a - b)) : [node]) {
    const match = matches.find(candidate => candidate.index <= offset && candidate.index + candidate.length >= offset + part.getTextContentSize());
    const kind = match && match.type !== 'link' ? match.type : 'text';
    if (part instanceof ReminderTextNode) part.setKind(kind);
    else part.replace(new ReminderTextNode(part.getTextContent(), kind));
    offset += part.getTextContentSize();
  }
}

export function $decorateReminder(projects: string[]): void {
  const matches = findActiveReminderMatches($readReminder(), projects).filter(match => match.type !== 'link');
  let offset = 0;
  const walk = (node: LexicalNode) => {
    if ($isLinkNode(node)) offset += $serialize(node).length;
    else if ($isTextNode(node)) {
      const length = node.getTextContentSize();
      $decorateText(node, offset, matches);
      offset += length;
    } else if ($isElementNode(node)) node.getChildren().forEach(walk);
    else offset += node.getTextContentSize();
  };
  $getRoot().getChildren().forEach((node, index) => {
    if (index) offset++;
    walk(node);
  });
  // A selection or paste can split one chip into several text nodes. Merge
  // matching neighbors through Lexical, preserving its selection bookkeeping.
  for (const node of $getRoot().getAllTextNodes()) {
    if (!(node instanceof ReminderTextNode) || !node.isAttached()) continue;
    let next = node.getNextSibling();
    while (next instanceof ReminderTextNode && next.getKind() === node.getKind()) {
      node.mergeWithSibling(next);
      next = node.getNextSibling();
    }
  }
}
