/**
 * Content hashing utilities for change detection
 * Uses FNV-1a hash algorithm for fast, browser-compatible hashing
 */

/**
 * Hash a string using FNV-1a algorithm
 * Fast, browser-compatible hash function
 */
function hashString(str: string): string {
  let hash = 2166136261; // FNV offset basis
  
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Hash file content for change detection
 */
export function hashFileContent(content: string): string {
  return hashString(content);
}

