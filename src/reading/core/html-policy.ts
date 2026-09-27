/** Shared by the reader sanitizer and its server-compatible text/source mapper. */
export const READING_HTML_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'a', 'blockquote', 'ul', 'ol', 'li', 'em', 'strong', 'b', 'i', 's', 'del', 'mark', 'sup', 'sub', 'br', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'];

// DOMPurify's forbidden-content set plus object/embed. Disallowed elements
// otherwise retain their text; allowed elements (such as thead) retain it too.
export const READING_DROP_CONTENTS = ['annotation-xml', 'audio', 'colgroup', 'desc', 'foreignobject', 'head', 'iframe', 'math', 'mi', 'mn', 'mo', 'ms', 'mtext', 'noembed', 'noframes', 'noscript', 'plaintext', 'script', 'selectedcontent', 'style', 'svg', 'template', 'thead', 'title', 'video', 'xmp', 'object', 'embed'];
