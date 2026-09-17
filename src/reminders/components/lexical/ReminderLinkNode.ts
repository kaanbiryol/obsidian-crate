import { LinkNode, type SerializedLinkNode } from '@lexical/link';
import type { EditorConfig } from 'lexical';

/** Keep the shared autocomplete/selection helpers' Markdown DOM boundary. */
export class ReminderLinkNode extends LinkNode {
  static getType() { return 'reminder-link'; }
  static clone(node: ReminderLinkNode) {
    return new ReminderLinkNode(node.__url, { rel: node.__rel, target: node.__target, title: node.__title }, node.__key);
  }
  static importJSON(value: SerializedLinkNode) {
    return new ReminderLinkNode(value.url).updateFromJSON(value);
  }
  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    element.dataset.markdownLink = 'true';
    return element;
  }
}
