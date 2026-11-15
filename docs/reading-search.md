# Reading library and search on the server

Target: a 50,000-note Reading library in the web app, encrypted or not, where a visit and a
search cost about the same at 1,000 and 50,000 notes. Obsidian is unchanged: it reads its own
vault and searches with Obsidian.

Replaces the card index described in [Reading at large library sizes](reading-scale.md). The
plugin work on that page (frontmatter-cache library, background work) and **Save for offline**
stay.

## Model

- Reading notes stay ordinary synced notes and the only source of truth.
- `reading_items` holds one row per note: what the web app lists. Rows are derived and can be
  rebuilt. Every commit keeps them current, so a policy created for an empty folder starts with a
  complete index. Otherwise notification passes rebuild it in steps of 25 notes and at most 16 MB,
  in encrypted vaults too (from each note's card); a web app read that finds it incomplete takes
  one step and answers 503 until it is done.
- `note_terms` holds each listed note's search terms, keyed by saved
  date: one per title word (`p:` and its first three letters, or `w:` and the whole word when
  shorter), `t:` for a tag and `u:` for the link identity (`src/reading/core/search-terms.ts`).
  The scope lets other note indexes, such as a future vault-wide one, share the table.
- `highlight_index` holds one row per highlighted note, keyed by when it was last highlighted
  (its newest highlight's date): the Highlights tab's pages. Its `terms` are the note's title,
  highlight and highlight-note words and its tags, in the same format.
- The web app never holds the library. It asks the server for one page at a time:
  `GET /reading/items?section=&q=&tag=&cursor=`, newest first, and lists every tag with
  `GET /reading/tags`.

## What each search matches

- **Inbox, Archived, Favorites:** title words, through `note_terms`.
- **Highlights:** highlight text, highlight notes and the title, through `highlight_index`. Each
  row's terms are checked in the row (`instr`), so a filtered page scans at most 2,000 rows, newest
  highlight first, and a short or empty page carries a cursor that continues the scan. The web app
  asks for up to four such pages per load, and loads again while the list end stays in view. A page also ends before its notes
  pass 512 KB. Article text is not searched; Obsidian searches it.
- **Tags:** the tags view lists every tag and searches the list on the device. Selecting a tag
  filters the current section by its `t:` term.

## Unencrypted vaults

The Worker writes the row and its terms in the same D1 batch as the file commit, as it already
did for `reading_items`. Words are lowercased with diacritics removed. A search walks its
rarest term newest first. Each other term is an exact key lookup in `note_terms` on the walked
entry, where a miss reads no row, so only notes with every term are read. Their whole title
words (`words`) then confirm the match by searching the row's JSON text (`instr`), which reads no
extra rows: a query word of 3 or more letters matches the start of a title word and a shorter one
a whole word. To find the rarest term it counts each term's notes, up to 50 and, when every term
has that many, up to 500.

## Encrypted vaults

The server cannot read notes, so the device that encrypts a note also builds its card, the same
way a reminder note carries its notification schedules:

- **The card travels in the upload.** When Obsidian's sync or the web app encrypts a Reading
  note, it attaches the card, the plaintext list fields and the hashed terms as the file's public
  data (`src/reading/core/reading-card-upload.ts`). The server validates it and writes the row and
  terms in the same batch as the file commit. Nothing else is sent and nothing runs in the
  background. A note that is not a valid Reading note uploads without a card and is not listed.
- **The card** is the note's listed item (`ReadingItem`) and plaintext hash, sealed with the
  vault key and bound to the note's server path.
- **No Shortcut saves.** Save to Crate cannot encrypt a note or hash its terms, so encrypted
  vaults refuse its pairing and saves (`409 shortcut_encrypted_vault`). Every listed note was
  encrypted by a device, so every note has terms and search reads only indexed notes.
- **List fields in plaintext**: saved date, status, favorite, whether the note has highlights and
  its Reading ID. The server sorts and filters by them; the device checks them against the card it
  decrypts and drops rows that disagree.
- **Terms** are HMAC-SHA256 under a search key derived from the vault key
  (`crate-e2ee-v1/reading-search`), truncated to 60 bits, of the same terms. A query sends, for
  each word, the hash of its first three letters (or of the whole word when it is shorter), so the
  server matches tokens it cannot read; the device rechecks the titles it decrypts.

- **Highlights and tags.** The card also carries when the note was last
  highlighted, the hashed highlight terms, and each tag's name sealed with the vault key and bound
  to its hashed term. The server keeps one sealed name per tag in `reading_tags` while any note has
  the term.

### What the server learns

Beyond what it already sees (sizes, write times, folder structure):

- each note's saved date, status, favorite, whether it has highlights and when it was last
  highlighted;
- which notes share a title word or prefix, a highlight word or prefix, a tag or a link, and the
  number of terms per note;
- how many distinct tags the library has;
- when a search repeats, and which notes it matches.

It never sees words, titles, tags, links, highlights or article text. This belongs in the
independent security review listed in [Reading and encryption](reading-e2ee-assessment.md).

## Web app

- **Online**: the library, every section, search and the tag filter are server pages. The tag
  picker lists tags on the pages it loaded.
- **Offline**: the library shows articles saved with **Save for offline**, and search matches
  their titles on the device.
- **Stored on the device**: only articles saved for offline, the queue of changes not yet sent,
  and an unsent link in the save form. Library pages stay in memory and are read again on each
  visit.
- Edits keep the pending-change queue, operation IDs and receipts. A pending edit is shown over
  the page that lists its note.
- Saving a link checks for a duplicate with a link-term query in encrypted vaults, and with the
  server's link index in unencrypted ones.

## Cost

Measured locally at 2,000 notes with 8-word titles (`d1-usage`, `write-cost` and `capacity`
integration tests keep the bounds):

| | Rows |
| --- | --- |
| New Reading note, written | about 22 (7 for any other note) |
| Favorite or archive, written | about 15 |
| Delete, written | about 25 |
| First page, read | about 56, at any library size |
| One-word search, read | about 104 for a full page; a rare word about 2 per match |
| Two-word search, read | at most about 1,600 when both words are common and never share a note; about 80 when one is rare |
| Add a highlight, written | about as many as a favorite: the note's `highlight_index` row adds 1 or 2 (a newer highlight moves the row) |
| Highlights page, read | about one page |
| Highlight search, read | about one page when matches are common; at most about 4,000 for a page with none (2,000 scanned, then a seek to where the scan ended) |
| Tag list, read | about one row per tag |

- Each title word is one term, and terms are keyed by saved date with no second index, so a
  search never scans the library and a term costs one written row.
- A status or favorite edit keeps the same terms and only moves the note between section
  indexes.
- D1 storage is about 2.6 KB per Reading note, most of it the listed item (`metadata_json`,
  including highlights) and, in an encrypted vault, its card.
