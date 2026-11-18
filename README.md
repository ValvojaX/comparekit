# Compare Kit

Compare and merge the files VS Code can't diff on its own: CSV and Excel
tables, images, ZIP archives and other binary files, plus whole folders and git
revisions. Text and code keep using VS Code's own diff and merge editors.

## Features

| | Compare | Merge (3-way) | View |
| --- | --- | --- | --- |
| Text and code | VS Code's diff editor | VS Code's merge editor | VS Code's editor |
| CSV, TSV | Side by side tables with key columns, columns matched by header, numeric tolerance, case and whitespace options | Cell by cell; an id column is detected automatically | Sortable, filterable grid (*Show as Table*) |
| Excel (.xlsx, .xlsm) | Per sheet, values or formulas | Cell by cell per sheet, sheets added or removed | Grid with sheet tabs (opens by default) |
| Images | Side by side with the difference between, difference only, overlay slider, blend; tolerance, zoom and pan, rotate and flip | Pick a whole version | VS Code's image preview |
| ZIP, JAR and similar | Entry tree; each entry opens in its own compare view | Entry by entry | — |
| Other binary | Hex view, compared by position, with go to offset | Pick a whole version | — |
| Folders | Left and right trees; same-size files are checked byte by byte | — | — |

Every compare view has a toolbar, a seam of difference markers, an overview strip
and a status bar, in the colors and fonts of your VS Code theme.
**Alt+Down / Alt+Up** (or **F7 / Shift+F7**) move between differences and conflicts.

## Starting a comparison

- **Explorer → right-click → Compare Kit**: *Select for Compare* on one file or folder, then *Compare with Selected* on another. The selected item is shown in the status bar (click it to clear). With two items selected, use *Compare Selected*. *Compare with Revision...* compares a file or folder with any git revision.
- **Editor title bar → Compare with...**: HEAD, the index, any revision of the file, another file, or the clipboard.
- **Source Control → Compare Revisions view**: pick *From* and *To* (branch, tag, commit or the working tree), optionally only the changes made on *To* since it split off (like a pull request), then *Compare*. *Recent Commits* shows what each commit changed.
- **Source Control → changed file**: *Open Changes (Compare Kit)*. On a file with merge conflicts: *Resolve in Merge Editor (Compare Kit)*; text conflicts go to VS Code's merge editor.
- **Timeline view → a commit**: *Compare with Working Copy (Compare Kit)* and *Compare with Previous (Compare Kit)*.
- **Command Palette**: *Compare: Compare Folders...*, *Compare: Compare Branches...*, *Compare: Show as Table*.

### Keybindings without pickers

```jsonc
{ "key": "ctrl+alt+b", "command": "vscodeCompare.compareBranches", "args": { "from": "main", "to": "HEAD", "mergeBase": true } }
```

`vscodeCompare.compareBranches` takes `{ from, to?, mergeBase? }` (omit `to` for the working tree);
`vscodeCompare.compareWithRevision` takes `(uri, ref)`.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `vscodeCompare.maxFileSizeMB` | `50` | Larger files aren't loaded into the compare views |
| `vscodeCompare.formatAssociations` | `{}` | Map file globs to a view, e.g. `{ "*.dat": "table" }`; `"text"` sends files to VS Code's diff editor |
| `vscodeCompare.folderExclude` | `**/.git`, `**/node_modules` | Left out of folder comparisons, along with `files.exclude` |

## Safety

- Nothing is written except by an explicit action in a merge view (*Save merge*, *Use ours*, ...). Deleting a file in a merge moves it to the trash.
- No network access and no child processes: files are read through VS Code's file system API, git revisions through the built-in git extension.
- Views run under a strict content security policy, load scripts only from the extension, and receive data only as messages.
- ZIP-based files (archives, Excel workbooks) are checked before they are opened: entry count, total size and compression ratio are capped.
- Git revisions you type can't start with `-`, so they can't be read as options.
- Works in Restricted Mode, and in Remote, WSL and container workspaces.

## Known limits

- Excel merges rewrite the workbook starting from ours: formatting is kept, but charts, pivot tables and macros may be lost, and moved rows don't update formula references.
- Merged ZIP archives are written again, so signatures inside them (.jar, .apk) no longer match.
- The hex view compares by position; an inserted byte shifts everything after it.
- Comparing a folder with a revision doesn't list untracked files.
