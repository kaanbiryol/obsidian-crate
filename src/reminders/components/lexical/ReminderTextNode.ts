import { TextNode, type EditorConfig, type NodeKey, type SerializedTextNode } from 'lexical';

export type ChipKind = 'text' | 'project' | 'priority' | 'date';
type SerializedReminderText = SerializedTextNode & { kind: ChipKind };

/** Editable text, not an atomic token: backspace and selection stay native to Lexical. */
export class ReminderTextNode extends TextNode {
  __kind: ChipKind;

  constructor(text = '', kind: ChipKind = 'text', key?: NodeKey) {
    super(text, key);
    this.__kind = kind;
  }

  static getType() { return 'reminder-text'; }
  static clone(node: ReminderTextNode) { return new ReminderTextNode(node.__text, node.__kind, node.__key); }
  static importJSON(value: SerializedReminderText) {
    return new ReminderTextNode(value.text, value.kind).updateFromJSON(value);
  }
  exportJSON(): SerializedReminderText { return { ...super.exportJSON(), kind: this.getKind() }; }
  getKind() { return this.getLatest().__kind; }
  setKind(kind: ChipKind) {
    if (this.getKind() !== kind) this.getWritable().__kind = kind;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    element.className = this.chipClass();
    return element;
  }

  updateDOM(previous: this, element: HTMLElement, config: EditorConfig): boolean {
    const replace = super.updateDOM(previous, element, config);
    if (previous.__kind !== this.__kind) element.className = this.chipClass();
    return replace;
  }

  private chipClass() {
    return this.__kind === 'text' ? '' : `rich-text-chip rich-text-chip-${this.__kind}`;
  }
}
