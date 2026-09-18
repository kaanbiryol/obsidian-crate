// Some binary formats (including PDFs) can contain valid UTF-8. Never expose
// their storage representation as a text diff, even when decoding would pass.
const BINARY_PATH = /\.(?:pdf|png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?|ico|icns|psd|ai|eps|mp3|m4a|aac|wav|flac|ogg|opus|aiff?|mp4|m4v|mov|webm|avi|mkv|mpeg|mpg|zip|gz|bz2|xz|7z|rar|tar|docx?|xlsx?|pptx?|odt|ods|odp|epub|woff2?|ttf|otf|eot|db|sqlite3?|exe|dll|dmg|wasm)$/i;

export function isBinaryPreviewPath(path: string): boolean {
    return BINARY_PATH.test(path);
}
