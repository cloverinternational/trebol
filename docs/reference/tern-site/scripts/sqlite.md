# SQLite Blocks

`sqlite` opens databases and drives their Structure, Browse, Execute and
Pragmas areas, the cell and plot sheets, and database dialogs and tools. Use
it to reproduce a database workflow, inspect query results or capture a
SQLite block without clicking through the window.

## Databases and views

| Command | Does |
| --- | --- |
| `sqlite fixture <name> [ro]` | Builds a fresh database from a committed SQL fixture and opens it beside the focused pane. |
| `sqlite open <path> [ro]` | Opens a database or project file. |
| `sqlite new <path>` | Creates a database beside the focused pane, replacing an existing file at that path. |
| `sqlite memory` | Opens an in-memory database. |
| `sqlite area structure\|browse\|execute\|pragmas` | Shows the named area. |
| `sqlite sheet cell\|plot\|schema\|off` | Shows a side sheet, or closes it. |
| `sqlite log on\|off` | Shows or hides the SQL Log. |
| `sqlite write` | Writes pending database changes. |
| `sqlite revert` | Asks before reverting pending changes. |
| `sqlite undo` | Undoes the last undoable database operation. |
| `sqlite exec <sql>` | Runs SQL statements in an undoable savepoint. |
| `sqlite close` | Closes the focused SQLite block through the close guard. |

Except for the four opening commands, these commands need a focused SQLite
block; otherwise they fail with `no SQLite block has focus`. `exec` needs a
writable database. Database errors can appear in the block rather than as a
failed command reply: check its state after opening or running SQL.

`ro` opens read-only. Fixtures come from
`crates/tern/goldens/fixtures/sqlite/<name>.sql`; each invocation replaces its
temporary database with a fresh copy. `new` also replaces an existing file:
use a disposable path. Revert and a dirty close can ask for confirmation;
answer with the harness's `dialog button <n>` command.

SQLite commands wait in real time until **every SQLite block** in the
window has finished opening and has no pending jobs, then advance app time
300 ms for drawing. The shared 20-second timeout fails the command if work
never settles. A confirmation dialog is not an unfinished database job, so
the next script line can answer it. These are not headless-only commands;
the script runner is available on native builds, not the browser build.
Opening a default app or a system file picker needs the corresponding
system integration; headless runs record those requests instead.

`tern ctl state` stores SQLite state in `sqlite_blocks`: its `blocks[]`
contains `id`, `name`, `path`, `memory`, `project`, `phase`, `dirty`,
`can_undo`, `read_only`, `busy`, `area`, `sheet`, `log`, `schema_seq` and
`data_seq`. `sqlite_blocks.recent` lists recent paths and their read-only
flags; `sqlite_blocks.asking` counts pending database questions. Below,
`block` means one entry in `sqlite_blocks.blocks[]`.

## Structure

| Command | Does |
| --- | --- |
| `sqlite structure [sheet] open <name>` | Unfolds a schema or object in the Structure area. |
| `sqlite structure [sheet] fold <name>` | Folds a schema or object in the Structure area. |
| `sqlite structure [sheet] select <name>[/<field>]` | Selects one listing row. |
| `sqlite structure [sheet] pick <name>[/<field>]` | Toggles a row in the selection. |
| `sqlite structure [sheet] menu` | Opens the current row's context menu. |
| `sqlite structure [sheet] browse` | Browses the selected table or view. |
| `sqlite structure [sheet] modify` | Opens the selected object's editor. |
| `sqlite structure [sheet] delete` | Deletes the selected objects through their confirmation flow. |
| `sqlite structure [sheet] copy-create` | Copies the selected objects' CREATE SQL. |
| `sqlite structure [sheet] copy-name` | Copies selected names. |
| `sqlite structure [sheet] copy-drop` | Copies text using the current drop options. |
| `sqlite structure [sheet] refresh` | Reloads the schema. |
| `sqlite structure [sheet] counts` | Toggles row counts. |
| `sqlite structure [sheet] unfold-all` | Unfolds the listing. |
| `sqlite structure [sheet] fold-all` | Folds the listing. |
| `sqlite structure [sheet] menu-key` | Runs the listing's keyboard menu action. |
| `sqlite structure [sheet] drop-sql <sql>` | Runs SQL text dropped onto the Structure area. |

Put `sheet` **before** the action to target the Schema sheet. The parser
also accepts it before `open`, `fold` and `drop-sql`, but those three still
act on the Structure area. Bare object names or schema-qualified names are
accepted. A field row must already be visible: unfold its object first.
A missing row, an empty selection for `menu`, or an unavailable action
fails the command. `pick` toggles membership rather than always adding it.

Inspect `block.structure.area` and `.sheet` for `open`, `shut`, `selected`,
`picked` and `rows`. `.objects` lists schema objects, `.counts` contains the
counting status and row counts, and `.tools` holds the tools state.

## Browse

| Command | Does |
| --- | --- |
| `sqlite browse table <name>` | Shows a table or view. |
| `sqlite browse select <row>:<column> [<row>:<column>]` | Selects a cell or rectangular range. |
| `sqlite browse rows <first> <last>` | Selects an inclusive range of whole records. |
| `sqlite browse edit <row>:<column> [<text>]` | Opens the inline editor, optionally with replacement text. |
| `sqlite browse commit` | Commits the open inline editor. |
| `sqlite browse set <row>:<column> [<text>]` | Writes a cell directly; omitted text is empty. |
| `sqlite browse key <id>` | Runs a Browse keyboard action. |
| `sqlite browse copy [headers\|sql]` | Copies the selection, plain by default. |
| `sqlite browse paste [<text>]` | Pastes tab/newline-separated text into the grid. |
| `sqlite browse find <text> [case] [whole] [regex]` | Opens Find and searches. |
| `sqlite browse replace <replacement> [all]` | Replaces the current match, or all matches from the current Find search. |
| `sqlite browse menu <row>:<column>` | Selects a cell and opens its context menu. |
| `sqlite browse menu row <n>` | Selects a record and opens its header menu. |
| `sqlite browse tab new\|close\|<n>` | Creates, closes or selects a Data Browser tab. |
| `sqlite browse goto <n>` | Scrolls to a record. |
| `sqlite browse jump <row>:<column>` | Follows the cell's foreign-key link. |

Rows, numeric columns and Browse tabs are 1-based; `0` as a row or tab is
treated as `1`. A column is its name, a 1-based data-column number, or
`rowid` for the leading column. Table names may be schema-qualified.
Text in `edit`, `set` and `paste` accepts `\t` and `\n`. Quote Find text
containing spaces; its flags can appear in any order. `replace` takes only
replacement text, not another search term. Missing tables, missing columns,
unknown action IDs and copying an empty selection fail the command.

Every action ID below is accepted after `sqlite browse key`:

| Command | Does |
| --- | --- |
| `refresh` | Reads the rows again. |
| `previous_table`, `next_table` | Browses the previous or next table, wrapping. |
| `new_tab`, `rename_tab`, `close_tab` | Creates, asks to rename or closes a Data Browser tab. |
| `new_record` | Inserts a record using defaults. |
| `insert_values` | Opens Add Record. |
| `delete_records`, `duplicate_record` | Deletes or duplicates selected records. |
| `copy_above` | Starts editing with the value from the cell above. |
| `set_null`, `clear_cells` | Sets selected cells to NULL or empty. |
| `delete` | Deletes whole selected records, otherwise empties selected cells. |
| `cut`, `copy_headers`, `copy_sql` | Cuts or copies the selection. |
| `select_all` | Loads and selects every cell. |
| `edit_cell` | Opens the current cell in the cell sheet. |
| `find`, `replace` | Opens Find or Find and Replace. |
| `find_next`, `find_previous` | Moves between matches. |
| `replace_next`, `replace_all` | Replaces one or every match using the Find bar. |
| `adjust_rows` | Toggles taller, wrapped rows. |
| `first_page`, `previous_page`, `next_page`, `last_page` | Navigates pages. |
| `goto_row` | Asks for a record number. |

The column IDs in the next table also work after `key`. Column settings,
filters and formats are part of Browse, not a separate command prefix:

| Command | Does |
| --- | --- |
| `sqlite browse filter <column> [<text>]` | Sets or clears a column filter. |
| `sqlite browse global [<text>]` | Sets or clears the global filter. |
| `sqlite browse sort <column> [add]` | Cycles the column's sort; `add` keeps other sort columns. |
| `sqlite browse hide <column>` | Hides a column. |
| `sqlite browse show-all` | Shows every hidden column. |
| `sqlite browse rowid [on\|off]` | Shows the rowid column, or hides it with `off`. |
| `sqlite browse freeze <column>\|off` | Freezes through a column, or unfreezes. |
| `sqlite browse width <column> <px>` | Sets a column width in pixels. |
| `sqlite browse format <column> [<preset-or-expression>]` | Sets a display preset, or opens the custom-expression editor and checks the expression. |
| `sqlite browse format-dialog <column>` | Opens the display-format dialog. |
| `sqlite browse condformat <column> [<filter>]` | Adds conditional formatting from a filter. |
| `sqlite browse condformats <column>` | Opens the conditional-format manager. |
| `sqlite browse condformats-add` | Presses Add in the manager. |
| `sqlite browse condformats-save` | Saves the manager's changes. |
| `sqlite browse fmt bold\|italic\|underline\|left\|center\|right\|justify\|clear` | Changes the selection's formatting. |
| `sqlite browse fmt fg\|bg [<hex>]` | Sets a foreground or background color. |
| `sqlite browse fmt font [<name>]` | Sets the formatting font. |
| `sqlite browse fmt size <n>` | Sets the formatting font size. |
| `sqlite browse select-col <column>` | Selects a whole column. |
| `sqlite browse findcol [<text>]` | Opens column search and finds a name. |
| `sqlite browse findcol-next`, `sqlite browse findcol-prev` | Moves between matching columns. |
| `sqlite browse unlock [<column>[,<column>...]]` | Checks a pseudo primary key for editing a view; an empty list locks it. |
| `sqlite browse lock` | Locks view editing. |
| `sqlite browse encoding [all] [<name>]` | Sets the text encoding for this table, or all tables. |
| `sqlite browse saveview [<name>]` | Creates a view of the filtered, sorted query. |
| `sqlite browse header-menu <column>` | Opens the column-header menu. |
| `sqlite browse filter-menu <column>` | Opens a filter field's menu. |
| `sqlite browse filter-help` | Opens filter syntax help. |

`width` takes an unsigned integer from 0 to 65535. `rowid` defaults to on;
only `off` hides it. `format ... default` removes a stored display format.
Preset keys are case-sensitive: `decimal`, `exponent`, `hexblob`, `hex`,
`octal`, `round`, `appleDate`, `javaEpoch`, `dotNetTicks`, `julian`, `epoch`,
`epochLocalTime`, `webkitEpoch`, `webkitEpochLocalTime`, `winDate`,
`ddmmyyyyDate`, `lower`, `upper`, `guid`, `geomToSVG` and `json`. Other text
is handled as a custom expression. Display formats need a data column,
not `rowid`.

These column action IDs also run directly as `sqlite browse <id>` (without
arguments), or through `sqlite browse key <id>`:

| Command | Does |
| --- | --- |
| `clear_filters`, `clear_sorting` | Clears filters or sort order. |
| `focus_filter`, `global_filter` | Focuses the current column's filter or the global filter. |
| `find_column` | Opens column search. |
| `show_rowid`, `freeze_columns` | Toggles rowid visibility or freezing through the current column. |
| `hide_columns`, `show_all_columns` | Hides selected columns or shows all columns. |
| `select_column` | Selects the current column. |
| `unlock_view` | Opens the pseudo-key prompt, or locks an unlocked view. |
| `display_format`, `cond_formats` | Opens the current column's format dialog. |
| `encoding_all` | Asks for an encoding for all tables. |
| `copy_column_name` | Copies the current column's name. |
| `format_toolbar` | Toggles the format toolbar. |
| `bold`, `italic`, `underline` | Toggles the selection's text styles. |
| `align_left`, `align_center`, `align_right`, `align_justify` | Sets the selection's alignment. |
| `clear_format` | Clears the selection's formats. |
| `save_as_view` | Asks for a view name. |
| `export_csv`, `export_json` | Opens export for the filtered, sorted rows. |
| `sqlite browse key encoding` | Asks for this table's encoding; direct `encoding` is the setting command above. |

Unavailable direct column actions fail with `can't run now`; edits still
follow the grid's read-only and selection rules. Inspect `block.browse` for
`tabs`, `current`, `table`, `sql`, `count`, `loaded`, `selection`, `cell`,
`editing`, `find` and `error`. `.columns` contains `filters`, `global`,
`where`, `sort`, `hidden`, `frozen`, `show_rowid`, `widths`,
`display_formats`, `cond_formats`, `row_id_formats`, `encoding`,
`pseudo_pk`, `editable`, `toolbar`, `find_column`, `dialog` and
`cond_editor`.

```text
ready
sqlite fixture sample
sqlite area browse
sqlite browse table tracks
sqlite browse filter milliseconds 200000~400000
sqlite browse filter name e
sqlite browse global o
sqlite browse sort price
sqlite browse sort name add
sqlite browse freeze name
sqlite browse condformat price >1
sqlite browse select 2:5
shot sqlite-browse-filters
```

## Execute

| Command | Does |
| --- | --- |
| `sqlite execute new [<title>]` | Creates a SQL tab. |
| `sqlite execute text [<text>]` | Replaces the current tab's SQL, leaving the caret at the end. |
| `sqlite execute type <text>` | Types at the caret, triggering completion as typing does. |
| `sqlite execute caret <n>` | Places the caret at a byte offset. |
| `sqlite execute select <from> <to>` | Selects a byte range. |
| `sqlite execute run` | Executes all SQL, or the selection. |
| `sqlite execute line` | Executes the statement at the caret's line. |
| `sqlite execute stop` | Stops execution. |
| `sqlite execute tab <n>` | Selects a SQL tab. |
| `sqlite execute close` | Closes the current tab, asking when needed. |
| `sqlite execute rename <title>` | Renames the current tab. |
| `sqlite execute duplicate` | Duplicates the current tab. |
| `sqlite execute move <from> <to>` | Reorders SQL tabs. |
| `sqlite execute complete` | Opens completion at the caret. |
| `sqlite execute accept` | Inserts the selected completion. |
| `sqlite execute pick <n>` | Selects a completion row. |
| `sqlite execute open <path>` | Opens an SQL file into a tab. |
| `sqlite execute save <path>` | Saves the current tab's SQL to a file. |
| `sqlite execute view <name>` | Saves the results' query as a view. |
| `sqlite execute cell <row> <column>` | Selects a result cell. |
| `sqlite execute copy [plain\|headers\|sql]` | Copies selected results, plain by default. |
| `sqlite execute tiling on\|off` | Puts results beside the editor, or below it. |
| `sqlite execute zoom in\|out\|reset` | Changes the editor's zoom. |
| `sqlite execute focus editor\|results` | Moves keyboard focus. |
| `sqlite execute chord <id>` | Runs an Execute keyboard action. |
| `sqlite execute log-source user\|app\|error` | Chooses the SQL Log's source. |
| `sqlite execute log-find <query>` | Searches the open SQL Log. |

Tabs, completion rows, result rows and result columns are **0-based**, unlike
Browse. Caret and selection offsets count bytes. `text` and `type` accept
`\n` and `\t`. All Execute commands require an open database; commands
that need a current SQL tab fail when there is none. An unknown tab, copying
without selected results, or searching a closed SQL Log also fails.
Query failures are shown in the tab's message and diagnostics. Like other
SQLite commands, execution waits for jobs to finish; a sequential `stop`
line cannot interrupt a preceding `run` that is still waiting.

| Command | Does |
| --- | --- |
| `execute`, `execute_line`, `stop` | Runs all/selected SQL, runs the current line or stops. |
| `new_tab`, `open_file` | Creates a tab or asks for SQL files. |
| `save_file`, `save_file_as` | Saves SQL, asking for a path when needed. |
| `close_tab`, `rename_tab`, `duplicate_tab` | Closes, asks to rename or duplicates the tab. |
| `next_tab`, `previous_tab` | Changes the current SQL tab. |
| `focus_editor`, `focus_results` | Moves focus. |
| `complete` | Opens completion. |
| `zoom_in`, `zoom_out`, `zoom_reset` | Changes editor zoom. |
| `copy_with_headers`, `copy_as_sql` | Copies selected results. |
| `export_csv`, `export_json` | Opens result export. |
| `save_as_view` | Asks for a view name. |
| `toggle_tiling` | Toggles results beside the editor. |

Inspect `block.execute.tabs[]` for SQL text, file, modified status, caret,
message, error, results and diagnostics; `.current`, `.running`, `.zoom`,
`.completion` and `.log` describe the rest of the area. `block.log` reports
whether the log is open. Tiling is a saved preference, not a dedicated state
field.

```text
ready
sqlite fixture sample
sqlite area execute
sqlite execute text SELECT a.title, ar.name AS artist, a.released\nFROM albums a\nJOIN artists ar ON ar.id = a.artist_id\nORDER BY a.released;
sqlite execute run
sqlite execute cell 0 0
sqlite execute tiling on
sqlite log on
shot sqlite-execute-tiled
sqlite execute log-find albums
shot sqlite-execute-log-find
```

## Pragmas

| Command | Does |
| --- | --- |
| `sqlite pragmas set <name> <value>` | Edits a pragma in the form. |
| `sqlite pragmas save` | Applies edited pragma values. |
| `sqlite pragmas reset` | Discards the form's edits. |
| `sqlite pragmas refresh` | Reads pragma values again. |

`set` requires a writable database and a name offered in the form:
`page_size`, `auto_vacuum`, `max_page_count`, `temp_store`, `secure_delete`,
`journal_mode`, `journal_size_limit`, `wal_autocheckpoint`, `synchronous`,
`locking_mode`, `fullfsync`, `checkpoint_fullfsync`, `foreign_keys`,
`recursive_triggers`, `ignore_check_constraints`, `case_sensitive_like`,
`automatic_index` or `user_version`.

Choice values accept their stored value or displayed label,
case-insensitively:

- `auto_vacuum`: `0`/`None`, `1`/`Full`, `2`/`Incremental`.
- `journal_mode`: `Delete`, `Truncate`, `Persist`, `Memory`, `WAL`, `Off`.
- `locking_mode`: `Normal`, `Exclusive`.
- `page_size`: `512`, `1024`, `2048`, `4096`, `8192`, `16384`, `32768`,
  `65536`, or their labels (`512 bytes`, `1 KiB`, through `64 KiB`).
- `synchronous`: `0`/`Off`, `1`/`Normal`, `2`/`Full`, `3`/`Extra`.
- `temp_store`: `0`/`Default`, `1`/`File`, `2`/`Memory`.

Checkbox values are on only for the exact words `1`, `on` or `true`;
anything else means off. Numeric form values are passed to the form for
validation. `fullfsync` and `checkpoint_fullfsync` affect macOS syncing.
Inspect `block.pragmas.values`, `.edits`, `.read`, `.reading` and `.error`.

## Cell

| Command | Does |
| --- | --- |
| `sqlite cell load <table> <rowid> <column>` | Loads a cell from a table in `main` and opens the Edit Cell sheet. |
| `sqlite cell mode text\|rtl\|binary\|image\|json\|xml\|svg\|evaluation` | Changes the editor mode. |
| `sqlite cell type [<text>]` | Replaces the text editor's content. |
| `sqlite cell hex-goto <offset>` | Moves the hex caret; decimal and `0x` hexadecimal are accepted. |
| `sqlite cell hex-type <digits>` | Types hex digits into the binary editor. |
| `sqlite cell apply` | Applies the buffered value. |
| `sqlite cell null` | Sets the buffer to NULL. |
| `sqlite cell discard` | Discards buffered edits. |
| `sqlite cell import <path>` | Imports file content into the buffer. |
| `sqlite cell import-ref <path>` | Imports a file reference. |
| `sqlite cell export <path>` | Exports cell content. |
| `sqlite cell export-dump <path>` | Exports a hex/ASCII dump. |
| `sqlite cell external` | Writes a temporary file, opens its default app and watches for changes. |
| `sqlite cell external-apply` | Reads the external file back, applies it and removes it. |
| `sqlite cell external-cancel` | Stops watching and removes the temporary file. |
| `sqlite cell open-default` | Opens the value's URL or existing file in its default app. |
| `sqlite cell copy-hex` | Copies a hex/ASCII representation. |
| `sqlite cell auto-switch on\|off` | Sets automatic mode selection. |
| `sqlite cell wrap on\|off` | Sets editor word wrapping. |
| `sqlite cell format on\|off` | Sets structured-text formatting. |
| `sqlite cell sort-keys on\|off` | Sets JSON key sorting. |
| `sqlite cell overwrite on\|off` | Sets binary overwrite mode. |

Every command except `load` needs a loaded cell. The rowid is the actual
signed database rowid, not a displayed Browse row number. `type` requires
an editable text mode; `hex-type` requires editable binary mode. Apply can
ask about invalid structured text or pending edits; answer the resulting
system dialog with `dialog button <n>`. External file changes are checked
once per second of app time; `external` does not wait for another app to
finish editing. External apply/cancel do nothing when no file is watched.

Inspect `block.cell.cell` for the source, table, row, column, key and value
class; `.mode`, `.read_only`, `.why`, `.modified`, `.null`, `.text`,
`.invalid`, `.diagnostics`, `.hex`, `.overwrite`, `.evaluating`, `.external`
and `.asking` describe the editor. State text is limited to 4000 characters.
The four editor preferences have no dedicated state fields.

## Plot

| Command | Does |
| --- | --- |
| `sqlite plot x <column>` | Sets the X column; `Row #` uses row numbers. |
| `sqlite plot y1\|y2 <column>` | Toggles a column on the left or right Y axis. |
| `sqlite plot color y1\|y2 <hex> <column>` | Sets a series color. |
| `sqlite plot line <style>` | Sets the line style. |
| `sqlite plot point <shape>` | Sets the point shape. |
| `sqlite plot legend on\|off` | Sets legend visibility. |
| `sqlite plot stacked on\|off` | Sets stacked bars. |
| `sqlite plot fixed on\|off` | Sets fixed number formatting. |
| `sqlite plot log-x on\|off` | Sets logarithmic X scaling. |
| `sqlite plot log-y on\|off` | Sets logarithmic Y scaling. |
| `sqlite plot load-all` | Loads every source row for plotting. |
| `sqlite plot hover <row>` | Shows the first finite point's readout for a source row. |
| `sqlite plot pick <row>` | Selects that point's source row in the grid. |
| `sqlite plot zoom <percent>` | Scales the current ranges; below 100 zooms in. |
| `sqlite plot reset` | Resets plot zoom. |
| `sqlite plot save <path>` | Writes an image, choosing the format by extension. |
| `sqlite plot copy` | Copies the plot image. |

Open the plot with `sqlite sheet plot` after choosing a Browse table or
Execute results. Column names must be present in the plot. Source row
numbers for `hover` and `pick` are **0-based**; a row without a plotted,
finite point fails. `zoom` needs a positive integer percentage. Invalid
colors, styles and shapes fail during parsing.

Styles, case-insensitively: `None`, `Line`, `StepLeft`, `StepRight`,
`StepCenter`, `Impulse`. Shapes, case-insensitively: `None`, `Cross`, `Plus`,
`Circle`, `Disc`, `Square`, `Diamond`, `Star`, `Triangle`,
`TriangleInverted`, `CrossSquare`, `PlusSquare`, `CrossCircle`, `PlusCircle`,
`Peace`. `Dot` is not a selectable script shape. Default styling is Line
with Disc markers unless preferences override it. Save supports PNG, BMP,
JPG/JPEG, SVG and PDF; an unknown or absent extension gets `.png` appended.

Inspect `block.plot.source`, `.columns`, `.x`, `.y1`, `.y2`, `.options`,
`.rows`, `.loaded`, `.total`, `.bars`, `.sorted`, `.x_type`, `.drawn`,
`.x_ticks`, `.zoomed`, `.selected`, `.line`, `.point` and `.hover`.

## Dialogs

| Command | Does |
| --- | --- |
| `sqlite dialogs create-table` | Opens Create Table. |
| `sqlite dialogs edit-table <name>` | Opens Edit Table. |
| `sqlite dialogs create-index [<table>]` | Opens Create Index, optionally on a table. |
| `sqlite dialogs edit-index <name>` | Opens Edit Index. |
| `sqlite dialogs add-record <table>` | Opens Add Record. |
| `sqlite dialogs import-csv <path>...` | Opens CSV import for one or more files. |
| `sqlite dialogs import-csv-text <text>` | Opens CSV import for clipboard-style text. |
| `sqlite dialogs import-sql <path> [new <database-path>]` | Imports an SQL file into this database or a new database. |
| `sqlite dialogs export-csv [<table>...]` | Opens CSV export. |
| `sqlite dialogs export-json [<table>...]` | Opens JSON export. |
| `sqlite dialogs export-query csv\|json <sql>` | Opens export for an SQL query. |
| `sqlite dialogs export-sql [<table>...]` | Opens SQL export. |
| `sqlite dialogs accept [<path>]` | Presses the open dialog's primary action; exports use a supplied destination instead of asking. |
| `sqlite dialogs cancel` | Closes the open dialog. |

Other words after `sqlite dialogs` go to the currently open dialog. The
following tables all use that same prefix; they are not nested under
`edit-table`, `import-csv`, etc. Wrong-dialog commands, missing objects,
out-of-range row numbers and missing dialogs fail. Dialog row numbers are
1-based and must be present. Boolean arguments in this area accept
`on|yes|true` or `off|no|false`.

Quote paths, names, CSV text and SQL containing spaces; the opening
commands take each as one argument. An omitted export table list opens the
picker rather than requiring a list in the script. Accept can leave the
dialog open with validation or database errors; import can ask about an
existing table. Inspect the dialog before continuing.

### Create and Edit Table

| Command | Does |
| --- | --- |
| `sqlite dialogs name [<name>]` | Sets the table name. |
| `sqlite dialogs schema <name>` | Chooses an available schema. |
| `sqlite dialogs without-rowid on\|off` | Sets WITHOUT ROWID. |
| `sqlite dialogs strict on\|off` | Sets STRICT mode. |
| `sqlite dialogs conflict none\|rollback\|abort\|fail\|ignore\|replace` | Sets the primary-key conflict action. |
| `sqlite dialogs tab fields\|constraints` | Shows fields or table constraints. |
| `sqlite dialogs add-field` | Adds a field. |
| `sqlite dialogs remove-field <n>` | Removes a field. |
| `sqlite dialogs move-field <n> up\|down\|top\|bottom` | Reorders a field. |
| `sqlite dialogs select <n>` | Selects a field row. |
| `sqlite dialogs field <n> name\|type\|default\|check\|collation [<text>]` | Edits a field property. |
| `sqlite dialogs field <n> nn\|pk\|ai\|unique on\|off` | Sets not-null, primary-key, autoincrement or unique. |
| `sqlite dialogs field <n> fk [none\|<table> [<column> [<clauses>...]]]` | Clears or sets an inline foreign-key target. |
| `sqlite dialogs add-pk` | Adds a primary-key constraint. |
| `sqlite dialogs add-unique` | Adds a unique constraint. |
| `sqlite dialogs add-fk` | Adds a foreign-key constraint. |
| `sqlite dialogs add-check` | Adds a CHECK constraint. |
| `sqlite dialogs key <n> columns <column>[,<column>...]` | Sets a key's columns. |
| `sqlite dialogs key <n> kind pk\|unique` | Changes a key's kind; any word except `pk` selects unique. |
| `sqlite dialogs key\|fk\|check <n> name [<text>]` | Names a constraint. |
| `sqlite dialogs fk <n> columns <column>[,<column>...]` | Sets foreign-key source columns. |
| `sqlite dialogs fk <n> references [none\|<table> [<column> [<clauses>...]]]` | Clears or sets the foreign-key target. |
| `sqlite dialogs check <n> expr [<expression>]` | Sets a CHECK expression. |
| `sqlite dialogs remove-key\|remove-fk\|remove-check <n>` | Removes a constraint of that kind. |
| `sqlite dialogs popover key\|fk-columns\|fk\|field-fk <n>` | Opens a column or foreign-key picker on a shown row. |
| `sqlite dialogs columns <column>[,<column>...]` | Applies columns in an open column picker. |

Constraint numbering is separate for keys, foreign keys and checks. Empty
column-list arguments clear the list. An omitted foreign-key target clears
it. Use clauses such as `ON DELETE CASCADE` after the target column. A
picker row must be shown on the current tab. Only `constraints` selects the
constraints tab; other words select fields. Duplicate fields, an invalid
primary-key arrangement and forbidden changes to referenced columns can
fail immediately; invalid table definitions are also reported on accept.

### Create and Edit Index

| Command | Does |
| --- | --- |
| `sqlite dialogs name [<name>]` | Sets the index name. |
| `sqlite dialogs table [<name>]` | Chooses an offered table. |
| `sqlite dialogs unique on\|off` | Sets uniqueness. |
| `sqlite dialogs where [<expression>]` | Sets or clears the partial-index condition. |
| `sqlite dialogs add <column>` | Adds an available table column. |
| `sqlite dialogs add-expr [<expression>]` | Adds an expression row. |
| `sqlite dialogs remove <n>` | Removes an index row. |
| `sqlite dialogs order <n> asc\|desc\|none` | Sets or clears a row's sort order; an empty string also clears it. |
| `sqlite dialogs expr <n> [<expression>]` | Edits an expression row. |
| `sqlite dialogs up\|down <n>` | Reorders a row. |

Table and column matching accepts names case-insensitively. `expr` fails
for a plain column row. Acceptance requires a valid name, table and index
contents.

### Add Record

| Command | Does |
| --- | --- |
| `sqlite dialogs value <n> [<text>]` | Sets a column value; empty text restores its default. |
| `sqlite dialogs null <n>` | Sets a column to NULL. |
| `sqlite dialogs empty <n>` | Sets an explicitly empty string. |
| `sqlite dialogs default <n>` | Restores a column's default. |
| `sqlite dialogs restore` | Restores all defaults. |

Generated columns cannot be assigned. Constraint failures leave the dialog
open so its values can be corrected and accepted again.

### CSV Import

| Command | Does |
| --- | --- |
| `sqlite dialogs header\|trim\|separate\|no-types\|local\|fail-missing\|ignore-defaults\|sanitize on\|off` | Sets the corresponding import option. |
| `sqlite dialogs advanced on\|off` | Shows or hides advanced options. |
| `sqlite dialogs separator comma\|semicolon\|tab\|pipe\|<character>` | Sets the field separator. |
| `sqlite dialogs separator other <character>` | Uses a custom separator. |
| `sqlite dialogs separator code <n>` | Uses a character code; 0 means no separator. |
| `sqlite dialogs quote double\|single\|none\|<character>` | Sets the quote character. |
| `sqlite dialogs quote other <character>` | Uses a custom quote character. |
| `sqlite dialogs quote code <n>` | Uses a character code; 0 means none. |
| `sqlite dialogs encoding <name>` | Chooses UTF-8, UTF-16, ISO-8859-1 or another named encoding. |
| `sqlite dialogs conflict abort\|ignore\|replace` | Sets handling of conflicting records. |
| `sqlite dialogs table <name>` | Sets the destination name, or the current file's name in separate-table mode. |
| `sqlite dialogs file <n>` | Chooses a file for preview. |
| `sqlite dialogs file <n> table <name>` | Sets one file's destination table. |
| `sqlite dialogs file <n> on\|off` | Includes or excludes a file. |
| `sqlite dialogs all on\|off` | Includes or excludes every file. |
| `sqlite dialogs match-similar` | Selects files with similar structure. |
| `sqlite dialogs answer yes\|no\|all\|cancel` | Answers the current existing-table question. |

Literal separators and quotes must be one character. Character codes are
unsigned decimal numbers. A custom `other` value can be empty to mean
none. Bad encoding names surface in the preview. `answer` fails unless a
question is pending; `all` answers Yes to all remaining questions.

### CSV and JSON Export

| Command | Does |
| --- | --- |
| `sqlite dialogs select <name> on\|off` | Includes or excludes a listed table. |
| `sqlite dialogs all`, `sqlite dialogs none` | Selects all tables or none. |
| `sqlite dialogs header on\|off` | Sets CSV column headers. |
| `sqlite dialogs separator ,\|;\|tab` | Sets a CSV separator. |
| `sqlite dialogs separator "\|"` | Uses a literal pipe as the CSV separator. |
| `sqlite dialogs separator other [<character>]` | Sets a custom CSV separator. |
| `sqlite dialogs quote "\|'\|none` | Sets a CSV quote character; quote the literal double quote as a script string. |
| `sqlite dialogs quote other [<character>]` | Sets a custom CSV quote. |
| `sqlite dialogs newline crlf\|lf` | Sets CSV line endings. |
| `sqlite dialogs newline other [<text>]` | Sets custom CSV line endings. |
| `sqlite dialogs pretty on\|off` | Sets JSON pretty printing. |

CSV controls fail for JSON exports, and `pretty` fails for CSV. A query
export has no table picker, so `select`, `all` and `none` fail there.

### SQL Export

| Command | Does |
| --- | --- |
| `sqlite dialogs select <name> on\|off` | Includes or excludes a listed table. |
| `sqlite dialogs all`, `sqlite dialogs none` | Selects all tables or none. |
| `sqlite dialogs what everything\|schema\|data` | Chooses the dump contents. |
| `sqlite dialogs column-names on\|off` | Includes column names in INSERT statements. |
| `sqlite dialogs multi-row on\|off` | Combines records in multi-row INSERT statements. |
| `sqlite dialogs keep-original on\|off` | Preserves original CREATE SQL. |
| `sqlite dialogs keep-schema on\|off` | Preserves original schema names. |

`block.dialogs.open` identifies the dialog; `.dialog` contains its fields,
options, preview, selection and validation status. `.job` reports progress,
and `.popover` describes an open picker. For imports, check the dialog's
question and remaining files before sending an answer.

## Tools

| Command | Does |
| --- | --- |
| `sqlite tools compact` | Opens the Compact dialog. |
| `sqlite tools integrity` | Runs a full integrity check. |
| `sqlite tools quick-check` | Runs a quick integrity check. |
| `sqlite tools fk-check` | Checks foreign keys. |
| `sqlite tools optimize` | Runs SQLite optimization. |
| `sqlite tools row-counts` | Runs a query of the tables' and views' row counts in a new Execute tab. |
| `sqlite tools save-project` | Saves the project, asking for a path when needed. |
| `sqlite tools save-all` | Saves the database and project. |
| `sqlite tools close-project` | Closes the associated project. |
| `sqlite tools detach-menu` | Detaches the only attached database, or opens a menu when several exist. |
| `sqlite tools save-project-as-dialog` | Asks for a new project destination. |
| `sqlite tools save-database-as-dialog` | Asks for a database-copy destination. |
| `sqlite tools pick <schema> on\|off` | Sets a schema checkbox in Compact. |
| `sqlite tools alias <name>` | Sets the Attach dialog's alias. |
| `sqlite tools ok` | Runs the open Compact or Attach dialog. |
| `sqlite tools cancel` | Closes tools dialogs. |
| `sqlite tools load-extension <path>` | Loads a SQLite extension. |
| `sqlite tools attach <path>` | Opens Attach for that database file; `:memory:` attaches an in-memory database. |
| `sqlite tools detach <name>` | Detaches a database alias. |
| `sqlite tools open-project <path>` | Opens a project file. |
| `sqlite tools save-project-as <path>` | Saves the project to a path, adding the project extension when needed. |
| `sqlite tools save-database-as <path>` | Copies the database to a new file. |
| `sqlite tools drop select\|insert\|names` | Chooses the text generated when dropping schema objects. |
| `sqlite tools drop qualified\|quoted` | Toggles schema qualification or quoted names in generated drop text. |

Compact requires a writable database. Checks, optimization and row counts
require an open one. Project saves require an open, file-backed database;
closing a project requires an associated project file. Save Database As is
unavailable while there are unwritten changes. Unavailable actions fail
with `can't run now`. `pick`, `alias` and `ok` fail without their matching
dialog. Tools `pick` accepts only `on` or `off`, unlike database-dialog
boolean aliases. `cancel` is harmless without a tools dialog.

Inspect `block.structure.tools.tasks`, `.compact` and `.attach` for work
and dialogs; `.compact` lists the schemas offered by Compact, not just the
checked ones. `block.project`, `.path`, `.dirty` and `.structure.objects`
reflect project, file and attach operations. Checks, optimization and
`row-counts` open Execute tabs; inspect `block.execute.tabs[].results` for
their output. Drop-text preferences have no dedicated state fields.

## See also

- [Scripts](index.md): running, timing, fixtures and shared syntax.
- [Harness Commands](harness.md): confirmation dialogs, input and captures.
- [Control Commands](control.md): inspecting state, trees and layout.
- [Files Pane](files.md): opening database files from a listing.
- [Debugging](../guides/debugging.md): driving a window from a script.
