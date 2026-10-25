export const CRATE_ICON_ID = 'crate-logo';

// Three separated faces from the Crate mark, simplified for Obsidian's 100×100 icons.
export const CRATE_ICON_SVG = `
<g fill="currentColor" stroke="none">
  <path d="M46 6Q50 4 54 6L89 27Q94 30 89 33L54 54Q50 56 46 54L11 33Q6 30 11 27Z"/>
  <path d="M8 40Q8 37 11 39L43 58Q47 60 47 65V92Q47 97 43 94L14 77Q8 73 8 67Z"/>
  <path d="M92 40Q92 37 89 39L57 58Q53 60 53 65V92Q53 97 57 94L86 77Q92 73 92 67Z"/>
</g>`;

export const CRATE_READER_ICON_ID = 'crate-reader';

// Obsidian's open book, on the same grid as its header icons, with the Crate mark in the corner. The book is cut away around the mark so they stay apart at header size.
export const CRATE_READER_ICON_SVG = `
<mask id="crate-reader-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
  <rect width="100" height="100" fill="#fff"/>
  <circle cx="77" cy="77" r="26" fill="#000"/>
</mask>
<path mask="url(#crate-reader-cut)" fill="none" stroke="currentColor" stroke-width="8.33" stroke-linecap="round" stroke-linejoin="round"
  d="M8.33 12.5h25a16.67 16.67 0 0 1 16.67 16.67v58.33a12.5 12.5 0 0 0-12.5-12.5h-29.17zM91.67 12.5h-25a16.67 16.67 0 0 0-16.67 16.67v58.33a12.5 12.5 0 0 1 12.5-12.5h29.17z"/>
<g fill="currentColor" stroke="none" transform="translate(55 55) scale(.45)">
  <path d="M46 6Q50 4 54 6L89 27Q94 30 89 33L54 54Q50 56 46 54L11 33Q6 30 11 27Z"/>
  <path d="M8 40Q8 37 11 39L43 58Q47 60 47 65V92Q47 97 43 94L14 77Q8 73 8 67Z"/>
  <path d="M92 40Q92 37 89 39L57 58Q53 60 53 65V92Q53 97 57 94L86 77Q92 73 92 67Z"/>
</g>`;
