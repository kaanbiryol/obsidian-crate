import { expect } from 'vitest';
import { equalBufferBytes } from './byte-equality';

// Apply to nested buffers and toContainEqual too, in both Node and Worker suites.
expect.addEqualityTesters([equalBufferBytes]);
