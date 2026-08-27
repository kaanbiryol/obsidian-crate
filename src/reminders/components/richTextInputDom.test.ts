import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusRichTextElement } from './richTextInputDom';

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
