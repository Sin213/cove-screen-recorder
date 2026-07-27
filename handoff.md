# Gallery: per-card delete, multi-select, copy-to-clipboard

## Task

Add quick management to the "Recent Recordings" gallery in
`src/components/Gallery.tsx`:

- Per-card **X** button (hover-revealed, top-left of thumbnail) deletes one
  recording with confirmation.
- Per-card **circle** checkbox (top-right of thumbnail) toggles that card in
  a multi-select set. Selecting any card reveals a bulk bar in the gallery
  header with `Delete (N)`, `Copy (N)`, `Clear`.
- **Copy to clipboard** (single or bulk) places the actual video file on the
  OS clipboard so it can be pasted into chat apps (Slack, Discord, Outlook)
  on Windows. This is the behavior the Windows Snipping Tool recorder uses.

Version bump: `3.2.1` -> `3.3.0` (user-confirmed; confirmed `package.json`
and CHANGELOG match).

## Scope (files changed)

| File | Change |
|------|--------|
| `package.json` | version: `3.2.1` -> `3.3.0` |
| `electron/main.ts` | add `clipboard` to the `electron` import on line 1; add `cove:delete-recording` and `cove:copy-recording-to-clipboard` IPC handlers below the existing `cove:list-recordings` block (around line 1107); new helper `safeOutputPath(p)` that resolves the user-picked or default output dir and rejects `..` traversal |
| `electron/types.ts` | extend `CoveApi` with `deleteRecording(path)` and `copyRecordingToClipboard(path)`, both returning `{ ok: boolean; error?: string }` |
| `electron/preload.ts` | wire the two new methods onto the `cove` object near line 28 |
| `src/components/Gallery.tsx` | add `Set<string>` selection state; hover-revealed X (top-left of thumb) and circle (top-right of thumb); bulk bar in header; `handleDelete` / `handleCopy` / `handleDeleteMany` / `handleCopyMany`; `reloadKey` state so manual refresh after delete works without changing `outputDir` / status; drop deleted paths from `thumbs` state |
| `src/index.css` | new classes: `.gallery-card-thumb-remove` (top-left X), `.gallery-card-checkbox` (top-right circle, accent-filled when selected), `.gallery-bulk-bar` (header flex row), `.gallery-bulk-btn` + danger variant |
| `CHANGELOG.md` | new `## [3.3.0] - 2026-07-26` section above `## [3.2.1]` with `### Added` listing the three features and a note that Linux/macOS file-paste-into-chat depends on the receiving app (no native file-dropboard there) |

No new dependencies. No new build steps. No helper/Rust changes.

## Design decisions

- **Corner placement** matches the user's wording ("X ... circle ... up in
  the corner"). X is top-left, circle is top-right, both hover-revealed
  except the circle stays visible once any selection exists so the user
  can deselect. Selected cards also gain a subtle accent border so the
  selection state is visible without hover.
- **Confirm via `window.confirm`** in the renderer. Cheap, no extra IPC.
  Worth migrating to `dialog.showMessageBox` later if a native look is
  desired; not now.
- **Path validation in main**: both new handlers must reject any path that
  is not inside the user-picked `outputDir` or the resolved
  `defaultOutputDir()`. Use `path.resolve` and `startsWith` after
  resolving. This blocks `..` traversal and prevents the handlers from
  being used as generic file-deletion or read primitives.
- **Clipboard approach**: `clipboard.write({ bookmark: name, text: name })`
  followed by `clipboard.writeBuffer('FileNameW', utf16leNameBuf)` and
  `clipboard.writeBuffer('FileContents', fileBuf)`. This populates the
  Win32 file-dropboard format that Slack/Discord/Outlook recognize. On
  macOS / Linux Chromium falls back to text-only, which is at worst a
  no-op (the existing "Copy path" still works in those cases - we keep
  the path-copy button as a fallback). 500 MB cap; refuse larger with a
  clear error so the user can move or trim the file first.
- **Atomic refresh**: after a successful delete, increment `reloadKey` and
  drop the deleted paths from `thumbs` immediately. The existing
  listing `useEffect` already depends on a few signals; adding
  `reloadKey` to the dep list is the smallest change.
- **No auto-bulk-copy edge cases**: the bulk copy is a loop of single
  copies. Each `clipboard.write` replaces the prior clipboard content,
  so the **last** copied file wins. Document this in the bulk-bar
  tooltip ("Copies the last selected recording") so we don't promise
  multi-file paste. Full multi-file paste-into-chat is a much bigger
  feature and out of scope here.

## Verification

- `npm run typecheck` - must pass (renderer + electron + validation
  tsconfigs).
- `npm run dev`:
  1. Record something -> file appears in the gallery.
  2. Hover the thumbnail -> X (top-left) and circle (top-right) appear.
  3. Click X -> confirm -> file disappears from list and from disk
     (`ls $outputDir`).
  4. Tick circles on three cards -> bulk bar shows `Delete (3)` /
     `Copy (3)` / `Clear`.
  5. Click `Delete (3)` -> confirm -> all three gone.
  6. Single copy: open Slack/Discord, paste -> the video attaches as a
     file (Windows).
  7. Try to delete a file via the renderer devtools with a path outside
     `outputDir` -> handler returns `{ ok: false, error: ... }`, no
     unlink.
  8. Try to copy a >500 MB file -> handler returns
     `{ ok: false, error: "file too large" }`, clipboard untouched.

## Out of scope

- Native confirmation dialog (`dialog.showMessageBox`).
- Multi-file clipboard paste (single-file is the realistic scope).
- Drag-out from gallery to file manager / chat (could be a follow-up
  using `webContents.startDrag`).
- Per-recording "Move to folder" / "Rename" / "Open in player" - the
  current "Reveal in folder" and thumb-click-to-open cover the common
  cases; defer to a follow-up if requested.

## Open question already resolved by user

- Bump to `3.3.0` (not `2.3.0` - that would be a regression from
  `3.2.1`). User confirmed `3.3.0` in chat. Build agent bumps
  `package.json` to `3.3.0` and titles the CHANGELOG entry
  `## [3.3.0] - 2026-07-26`.
