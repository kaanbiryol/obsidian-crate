import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusRichTextElement, syncActiveProjectChip } from './richTextInputDom';

function createClassList(initialClasses: string[] = []) {
  const classes = new Set(initialClasses);
  return {
    add: (className: string) => classes.add(className),
    remove: (className: string) => classes.delete(className),
    contains: (className: string) => classes.has(className),
  };
}

describe('focusRichTextElement', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('focuses once and moves the caret without delayed retries', () => {
    const range = {
      setStart: vi.fn(),
      collapse: vi.fn(),
    };
    const selection = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    const setTimeoutSpy = vi.fn();
    const focus = vi.fn();
    const trailingText = {
      nodeType: 3,
      nodeName: '#text',
      textContent: ' ',
      childNodes: [],
    };
    const element = {
      focus,
      nodeType: 1,
      nodeName: 'DIV',
      textContent: null,
      childNodes: [trailingText],
    } as unknown as HTMLDivElement;

    vi.stubGlobal('document', { createRange: () => range });
    vi.stubGlobal('window', {
      getSelection: () => selection,
      setTimeout: setTimeoutSpy,
    });

    focusRichTextElement(element);

    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(range.setStart).toHaveBeenCalledWith(trailingText, 1);
    expect(range.collapse).toHaveBeenCalledWith(true);
    expect(selection.removeAllRanges).toHaveBeenCalledOnce();
    expect(selection.addRange).toHaveBeenCalledWith(range);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});

describe('syncActiveProjectChip', () => {
  it('marks only the project chip containing the caret', () => {
    const chipClassList = createClassList();
    const projectChip = { classList: chipClassList };
    const focusElement = { closest: () => projectChip };
    const projectTextNode = { nodeType: 3, parentElement: focusElement };
    let focusNode: object | null = projectTextNode;
    const editor = {
      ownerDocument: {
        getSelection: () => ({ focusNode }),
      },
      getRootNode: () => ({ activeElement: editor }),
      contains: (node: object) => node === projectTextNode || node === projectChip,
      querySelectorAll: () => [projectChip],
    } as unknown as HTMLDivElement;

    syncActiveProjectChip(editor);
    expect(chipClassList.contains('is-cursor-active')).toBe(true);

    focusNode = null;
    syncActiveProjectChip(editor);
    expect(chipClassList.contains('is-cursor-active')).toBe(false);
  });
});
