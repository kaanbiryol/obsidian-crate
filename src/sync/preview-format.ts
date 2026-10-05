// Some binary formats (including PDFs) can contain valid UTF-8. Never expose
// their storage representation as a text diff, even when decoding would pass.
const BINARY_PATH = /\.(?:pdf|png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?|ico|icns|psd|ai|eps|mp3|m4a|aac|wav|flac|ogg|opus|aiff?|mp4|m4v|mov|webm|avi|mkv|mpeg|mpg|zip|gz|bz2|xz|7z|rar|tar|docx?|xlsx?|pptx?|odt|ods|odp|epub|woff2?|ttf|otf|eot|db|sqlite3?|exe|dll|dmg|wasm)$/i;

export const MAX_PREVIEW_BYTES = 256_000;

export function isBinaryPreviewPath(path: string): boolean {
    return BINARY_PATH.test(path);
}

/** Decode display text; callers retain their own read, size and integrity checks. */
export function decodePreviewText(bytes: ArrayBuffer, options: { preserveBom: boolean }): string {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: options.preserveBom }).decode(bytes);
    // eslint-disable-next-line no-control-regex -- Allow tabs and line endings, but reject binary control characters.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('Not a text file');
    return text;
}
