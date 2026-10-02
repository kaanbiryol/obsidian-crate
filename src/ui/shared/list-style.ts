export type ListStyle = 'cards' | 'flat';

export const DEFAULT_LIST_STYLE: ListStyle = 'flat';

export function normalizeListStyle(value: unknown): ListStyle {
    return value === 'cards' || value === 'flat' ? value : DEFAULT_LIST_STYLE;
}
