import assert from 'node:assert/strict';

// Synthetic events check our gesture policy; native iOS navigation needs device QA.
export async function checkBackGesture(page, selector, articleOpen = false) {
 const result = await page.locator(selector).evaluate(target => {
  const start = (xs, cancelable = true) => {
   const event = new Event('touchstart', { bubbles: true, cancelable });
   Object.defineProperty(event, 'touches', { value: xs.map(clientX => ({ clientX })) });
   target.dispatchEvent(event);
   return event.defaultPrevented;
  };
  return { edge: start([2]), center: start([160]), pinch: start([2, 80]), noncancelable: start([2], false) };
 });
 assert.deepEqual(result, { edge: !articleOpen, center: false, pinch: false, noncancelable: false });
}
