import { describe, expect, it } from 'vitest';
import { buildProjectTree } from './ProjectTree';
import { buildBrowseProjectCardsViewModel } from './viewModels';

describe('project hierarchy', () => {
  it('groups out-of-order descendants without merging their counts or losing paths', () => {
    const cards = buildBrowseProjectCardsViewModel(['Personal/Finance', 'Work', 'Personal', 'Personal/Health/Visits'], []);
    const tree = buildProjectTree(cards);
    expect(tree.map(node => node.path)).toEqual(['Personal', 'Work']);
    expect(tree[0]?.card).toBe(cards[2]);
    expect(tree[0]?.children[0]).toMatchObject({ label: 'Finance', path: 'Personal/Finance', card: cards[0] });
    expect(tree[0]?.children[1]?.card).toBeUndefined();
    expect(tree[0]?.children[1]?.children[0]?.card).toBe(cards[3]);
  });
});
