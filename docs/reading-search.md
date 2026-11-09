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
  rebuilt.
- `note_terms` holds each listed note's search terms under scope `reading`: `w:` for a title
  word, `p:` for its first three letters, `t:` for a tag and `u:` for the link identity
  (`src/reading/core/search-terms.ts`). The scope lets other note indexes, such as a future
  vault-wide one, share the table.
- The web app never holds the library. It asks the server for one page at a time:
  `GET /reading/items?section=&q=&tag=&cursor=`, newest first.

## Unencrypted vaults

The Worker writes the row and its terms in the same D1 batch as the file commit, as it already
did for `reading_items`. Words are lowercased with diacritics removed. A search matches each query
word as the start of a title word, with a range over the `w:` terms; a tag or link filter matches
its term exactly.

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
- **Shortcut saves** are created by the server, which cannot use the vault key. It seals the card
  to the vault seal key, like the note itself, so the note is listed at once. The server cannot
  hash terms, so the note is found by search once a device saves it again. Opening or editing a
  sealed note checks that it does not replace a note or take another note's name.
- **List fields in plaintext**: saved date, status, favorite, whether the note has highlights and
  its Reading ID. The server sorts and filters by them; the device checks them against the card it
  decrypts and drops rows that disagree.
- **Terms** are HMAC-SHA256 under a search key derived from the vault key
  (`crate-e2ee-v1/reading-search`), truncated to 60 bits, of the same terms. A query sends, for
  each word, the hash of its first three letters (or of the whole word when it is shorter), so the
  server matches tokens it cannot read; the device rechecks the titles it decrypts.

### What the server learns

Beyond what it already sees (sizes, write times, folder structure):

- each note's saved date, status, favorite and whether it has highlights;
- which notes share a title word or prefix, a tag or a link, and the number of terms per note;
- when a search repeats, and which notes it matches.

It never sees words, titles, tags, links, highlights or article text. This belongs in the
independent security review listed in [Reading and encryption](reading-e2ee-assessment.md).

## Web app

- **Online**: the library, every section, search and the tag filter are server pages. The tag
  picker lists tags on the pages it loaded.
- **Offline**: the library shows articles saved with **Save for offline**, and search matches
  their titles on the device.
- Edits keep the pending-change queue, operation IDs and receipts. A pending edit is shown over
  the page that lists its note.
- Saving a link checks for a duplicate with a link-term query in encrypted vaults, and with the
  server's link index in unencrypted ones.

## Cost

- A page or a search reads about one page of rows plus the matched search entries; nothing grows
  with the library.
- A new or retitled note writes about two terms per title word; status and favorite edits keep
  the same terms and leave them untouched, but move the note between section indexes (two rows).
- An encrypted library is indexed as it uploads: each note's card adds nothing beyond its upload.
