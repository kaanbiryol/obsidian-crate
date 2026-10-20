import { LinkNode, type SerializedLinkNode } from '@lexical/link';
import type { EditorConfig } from 'lexical';

/** Keep the shared autocomplete/selection helpers' Markdown DOM boundary. */
export class ReminderLinkNode extends LinkNode {
  __direct = false;
  isDirect() { return this.getLatest().__direct; }
  setDirect(direct: boolean) { this.getWritable().__direct = direct; return this; }
  exportJSON(): SerializedLinkNode & { direct: boolean } { return { ...super.exportJSON(), direct: this.isDirect() }; }
  static getType() { return 'reminder-link'; }
  static clone(node: ReminderLinkNode) {
    const clone = new ReminderLinkNode(node.__url, { rel: node.__rel, target: node.__target, title: node.__title }, node.__key);
    clone.__direct = node.__direct;
    return clone;
  }
  static importJSON(value: SerializedLinkNode & { direct?: boolean }) {
    return new ReminderLinkNode(value.url).updateFromJSON(value).setDirect(value.direct ?? false);
  }
  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    element.dataset.markdownLink = 'true';
    if (this.isDirect()) element.dataset.directLink = 'true';
    return element;
  }
}
