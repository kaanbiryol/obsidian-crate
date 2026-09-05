/** A reorder gesture must not become an edit click when the pointer is released. */
export function createReorderClickGuard() {
  let reordered = false;
  return {
    block: () => { reordered = true; },
    reset: () => { reordered = false; },
    // Keyboard/assistive activation has no pointer click count.
    shouldBlock: (event: Pick<MouseEvent, 'detail'>) => reordered && event.detail !== 0,
  };
}
