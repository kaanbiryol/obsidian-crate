import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusRichTextElement } from './richTextInputDom';

describe('focusRichTextElement', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('focuses once and moves the caret without delayed retries', () => {
    const range = {
      selectNodeContents: vi.fn(),
      collapse: vi.fn(),
    };
    const selection = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    const setTimeoutSpy = vi.fn();
    const focus = vi.fn();
    const element = { focus } as unknown as HTMLDivElement;

    vi.stubGlobal('document', { createRange: () => range });
    vi.stubGlobal('window', {
      getSelection: () => selection,
      setTimeout: setTimeoutSpy,
    });

    focusRichTextElement(element);

    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(range.selectNodeContents).toHaveBeenCalledWith(element);
    expect(range.collapse).toHaveBeenCalledWith(false);
    expect(selection.removeAllRanges).toHaveBeenCalledOnce();
    expect(selection.addRange).toHaveBeenCalledWith(range);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
