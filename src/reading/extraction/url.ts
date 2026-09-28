import { readingUrl } from '../core/model';

export function isPublicIPv4(value: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const [a, b, c, d] = value.split('.').map(Number) as [number, number, number, number];
  if ([a, b, c, d].some(part => part > 255) || a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return false;
  if (a === 192 && (b === 0 || b === 2 || b === 88 && c === 99) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) return false;
  return true;
}
export function extractionUrl(value: string): URL {
  const url = new URL(readingUrl(value)), host = url.hostname.toLowerCase();
  if (url.port || host.includes(':') || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/.test(host)) throw new Error('Unsupported destination');
  if (/^[\d.]+$/.test(host) && !isPublicIPv4(host)) throw new Error('Private destination');
  url.hash = '';
  return url;
}
