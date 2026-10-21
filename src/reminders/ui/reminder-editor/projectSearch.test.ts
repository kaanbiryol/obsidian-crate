import { describe, expect, it } from 'vitest';
import { extractHashtagQuery } from './projectSearch';

describe('extractHashtagQuery', () => {
    it.each([' ', '\u00a0', '\t', '\n'])('opens and filters projects after a %j boundary', separator => {
        for (const query of ['', 'Wo']) {
            const text = `dsakldsaj tomorrow${separator}#${query}`;
            expect(extractHashtagQuery(text, text.length)).toEqual({
                query, startIndex: text.indexOf('#'),
            });
        }
    });

    it.each([' ', '\u00a0', '\t', '\n'])('stops suggestions after a %j boundary', separator => {
        const text = `#Work${separator}later`;
        expect(extractHashtagQuery(text, text.length)).toBeNull();
    });

    it('keeps hashtag detection local to the caret', () => {
        expect(extractHashtagQuery('Task #Wo later', 8)).toEqual({ query: 'Wo', startIndex: 5 });
        expect(extractHashtagQuery('#', 1)).toEqual({ query: '', startIndex: 0 });
        expect(extractHashtagQuery('word#Wo', 7)).toBeNull();
        expect(extractHashtagQuery('#Wo', 0)).toBeNull();
        expect(extractHashtagQuery('#Wo', 4)).toBeNull();
    });
});
