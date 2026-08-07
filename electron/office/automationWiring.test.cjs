'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const builderSource = fs.readFileSync(path.join(root, 'electron-builder.config.cjs'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'electron', 'ipc.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'electron', 'office', 'uno_worker.py'), 'utf8');

describe('Office Agent wiring', () => {
  it('shares one local Office provider with the Agent and folder-grant IPC handlers', () => {
    assert.match(ipcSource, /createOfficeAutomationProvider/);
    assert.match(ipcSource, /officeToolProvider:\s*officeAutomation/);
    // REST/MCP share the same provider instance as the built-in AI.
    assert.match(ipcSource, /officeAutomation,/);
    const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
    assert.match(mainSource, /officeProvider:\s*ipcServices\?\.officeAutomation/);
    assert.match(ipcSource, /onBeforeDocumentWrite|closeEditorsForPath|office:documentApplied/);
    assert.match(ipcSource, /ai:workspaceStatus/);
    assert.match(ipcSource, /ai:pickWorkspace/);
    assert.match(ipcSource, /ai:clearWorkspace/);
    assert.match(ipcSource, /properties:\s*\['openDirectory'\]/);
    assert.match(ipcSource, /filter\(\(\{ unattended \}\) => unattended !== false\)/);
  });

  it('refuses to overwrite a document whose open tab has unsaved edits', () => {
    // The renderer owns the dirty flag; the main process cannot refuse a write
    // it never hears about, and closing the session would drop those edits.
    const appSource = fs.readFileSync(path.join(root, 'src', 'app', 'App.tsx'), 'utf8');
    assert.match(appSource, /setEditorModified/);
    assert.match(preloadSource, /setEditorModified/);
    assert.match(ipcSource, /office:editorModified/);
    assert.match(ipcSource, /session\.modified/);
  });

  it('gates REST/MCP Office calls behind the in-app approval prompt', () => {
    const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
    assert.match(mainSource, /createApprovalGate/);
    // Both start paths — first launch and every settings change — must pass it,
    // or confirm mode silently stops asking.
    assert.equal(mainSource.match(/requestApproval:\s*restApprovals\.request/g)?.length, 2);
    assert.match(mainSource, /restApprovals\.reset\(\)/);
    // The question is drawn in the AI panel, not in an OS dialog that steals
    // focus and cannot say which document it means.
    assert.match(mainSource, /requestToolApproval/);
    assert.doesNotMatch(mainSource, /showMessageBox/);
  });

  it('asks in the AI panel, and keeps the answer where the user can see it', () => {
    const appSource = fs.readFileSync(path.join(root, 'src', 'app', 'App.tsx'), 'utf8');
    const panelSource = fs.readFileSync(
      path.join(root, 'src', 'app', 'components', 'AIChatPanel.tsx'), 'utf8',
    );
    // App owns the subscription because the panel is lazy: a request nobody
    // draws is a request that times out denied.
    assert.match(appSource, /onOfficeToolApproval\(/);
    assert.match(appSource, /setAiOpen\(true\)/);
    assert.match(appSource, /officeApprovals=\{officeApprovals\.pending\}/);
    assert.match(panelSource, /<OfficeApprovalCard/);
    assert.match(panelSource, /<OfficeApprovalTrail/);
    assert.match(ipcSource, /office:toolApprovalResponse/);
    assert.match(preloadSource, /onOfficeToolApproval\b/);
    assert.match(preloadSource, /respondOfficeToolApproval/);
  });

  it('exposes only status, explicit folder selection, and clear actions to the renderer', () => {
    assert.match(preloadSource, /getAiWorkspaceStatus/);
    assert.match(preloadSource, /pickAiWorkspace/);
    assert.match(preloadSource, /grantAiWorkspaceForPath/);
    assert.match(preloadSource, /clearAiWorkspace/);
    assert.doesNotMatch(preloadSource, /setAiWorkspaceRoot/);
  });

  it('ships the fixed-operation Python bridge outside the asar archive', () => {
    assert.match(builderSource, /electron\/office\/uno_worker\.py/);
  });

  it('allow-lists the V2 structural editing operations in the fixed UNO bridge', () => {
    assert.match(workerSource, /'word_insert_table':/);
    assert.match(workerSource, /'excel_format_range':/);
    assert.match(workerSource, /'excel_create_chart':/);
    assert.match(workerSource, /'presentation_add_slide':/);
    assert.match(workerSource, /'presentation_duplicate_slide':/);
    assert.match(workerSource, /'presentation_delete_slide':/);
  });

  it('allow-lists the authoring and styling operations a generated document needs', () => {
    // Without these the agent can only replace text that is already there, and
    // a deck it builds keeps the template default — the "unreadable output"
    // this set exists to fix.
    assert.match(workerSource, /'word_append':/);
    assert.match(workerSource, /'word_format_text':/);
    assert.match(workerSource, /'excel_compose_table':/);
    assert.match(workerSource, /'presentation_format_text':/);
    assert.match(workerSource, /'presentation_set_background':/);
    // Paragraph styles are what make a heading a heading.
    assert.match(workerSource, /WORD_BLOCK_STYLES = \{/);
    assert.match(workerSource, /'heading1': 'Heading 1'/);
    // VertJustify takes the enum; the constant group of the same name throws.
    assert.match(workerSource, /uno\.Enum\(\s*'com\.sun\.star\.table\.CellVertJustify'/);
    assert.match(workerSource, /EXCEL_TABLE_THEMES = \{/);
    assert.match(workerSource, /com\.sun\.star\.drawing\.Background/);
  });

  it('allow-lists the V3 media, notes, header-footer, and template operations', () => {
    assert.match(workerSource, /'word_insert_image':/);
    assert.match(workerSource, /'word_set_header_footer':/);
    assert.match(workerSource, /'presentation_insert_image':/);
    assert.match(workerSource, /'presentation_set_notes':/);
    assert.match(workerSource, /'template_fill':/);
  });

  it('allow-lists the V4 comments, sorting, filtering, and presentation table operations', () => {
    assert.match(workerSource, /'word_add_comment':/);
    assert.match(workerSource, /'excel_sort_range':/);
    assert.match(workerSource, /'excel_apply_autofilter':/);
    assert.match(workerSource, /'presentation_insert_table':/);
  });

  it('uses fixed UNO document services for the V4 operations', () => {
    assert.match(workerSource, /com\.sun\.star\.text\.textfield\.Annotation/);
    assert.match(workerSource, /uno\.createUnoStruct\('com\.sun\.star\.table\.TableSortField'\)/);
    assert.match(
      workerSource,
      /uno\.Any\(\s*'\[\]com\.sun\.star\.table\.TableSortField', \(sort_field,\)\s*\)/,
    );
    assert.match(workerSource, /property_value\(\s*'ContainsHeader'/);
    assert.match(workerSource, /document\.DatabaseRanges/);
    assert.match(workerSource, /database_range\.AutoFilter = True/);
    assert.match(workerSource, /com\.sun\.star\.drawing\.TableShape/);
    assert.match(workerSource, /table = shape\.Model/);
  });

  it('allow-lists V5 pivot tables using fixed DataPilot services', () => {
    assert.match(workerSource, /'excel_create_pivot':/);
    assert.match(workerSource, /getDataPilotTables\(\)/);
    assert.match(workerSource, /createDataPilotDescriptor\(\)/);
    assert.match(workerSource, /descriptor\.setSourceRange\(source_address\)/);
    assert.match(workerSource, /com\.sun\.star\.sheet\.DataPilotFieldOrientation/);
    assert.match(workerSource, /com\.sun\.star\.sheet\.GeneralFunction/);
    assert.match(workerSource, /insertNewByName\(pivot_name, output_address, descriptor\)/);
    assert.match(workerSource, /pivot_table\.getOutputRange\(\)/);
  });

  it('builds multi-field pivots with fixed DataPilot sort and auto-show structs', () => {
    // Every field area the engine has, so a pivot is not stuck at one row field
    // and one measure.
    assert.match(workerSource, /pivot_orientation\('ROW'\)/);
    assert.match(workerSource, /pivot_orientation\('COLUMN'\)/);
    assert.match(workerSource, /pivot_orientation\('PAGE'\)/);
    assert.match(workerSource, /uno\.createUnoStruct\('com\.sun\.star\.sheet\.DataPilotFieldSortInfo'\)/);
    assert.match(workerSource, /com\.sun\.star\.sheet\.DataPilotFieldSortMode\.DATA/);
    assert.match(workerSource, /uno\.createUnoStruct\('com\.sun\.star\.sheet\.DataPilotFieldAutoShowInfo'\)/);
    assert.match(workerSource, /com\.sun\.star\.sheet\.DataPilotFieldShowItemsMode\.FROM_TOP/);
  });

  it('draws the pivot chart over the pivot body, not over its totals', () => {
    // The chart and the plain chart operation go through one placement helper,
    // and the range charted excludes the page-field rows above the table and
    // the grand total below it — a grand total plotted as a category dwarfs
    // every real one.
    assert.match(workerSource, /def add_sheet_chart\(/);
    assert.match(workerSource, /def pivot_chart_range\(/);
    assert.match(workerSource, /charts\.addNewByName\(/);
    assert.match(workerSource, /start_row \+= len\(filter_fields\) \+ 1/);
    assert.match(workerSource, /start_row \+= len\(column_fields\)/);
    assert.match(workerSource, /end_row -= measure_count/);
  });

  it('names the measures rather than leaving the engine to', () => {
    // "Sum - 收入" over a column of a Chinese report is the same tell as
    // "Total Result" was under it.
    assert.match(workerSource, /data_field\.setName\(str\(label\)\)/);
  });

  it('formats the pivot output range it just wrote', () => {
    assert.match(workerSource, /output\.NumberFormat = number_format_key\(document, number_format\)/);
    assert.match(workerSource, /output\.Columns\.OptimalWidth = True/);
  });

  it('allow-lists V8 tracked Word changes and Excel conditional formatting', () => {
    assert.match(workerSource, /'word_read_changes':/);
    assert.match(workerSource, /'word_replace_tracked':/);
    assert.match(workerSource, /document\.getRedlines\(\)\.createEnumeration\(\)/);
    assert.match(workerSource, /document\.RecordChanges = True/);
    assert.match(workerSource, /'excel_add_conditional_format':/);
    assert.match(workerSource, /com\.sun\.star\.sheet\.ConditionOperator/);
    assert.match(workerSource, /conditional_format\.addNew/);
    assert.match(workerSource, /selected\.ConditionalFormat = conditional_format/);
  });

  it('allow-lists controlled tracked-change resolution and trusted document macros', () => {
    assert.match(workerSource, /'word_resolve_changes':/);
    assert.match(workerSource, /\.uno:AcceptAllTrackedChanges/);
    assert.match(workerSource, /\.uno:RejectAllTrackedChanges/);
    assert.match(workerSource, /'macro_run':/);
    assert.match(workerSource, /property_value\('MacroExecutionMode', 9\)/);
    assert.match(workerSource, /com\.sun\.star\.configuration\.ConfigurationUpdateAccess/);
    assert.match(workerSource, /configuration\.SecureURL/);
    assert.match(workerSource, /document\.getScriptProvider\(\)/);
    assert.match(workerSource, /\.invoke\(/);
  });

  it('embeds only workspace-resolved images and returns presentation notes', () => {
    assert.match(workerSource, /uno\.systemPathToFileUrl\(request\['imagePath'\]\)/);
    assert.match(
      workerSource,
      /uno\.Enum\(\s*'com\.sun\.star\.text\.TextContentAnchorType', 'AS_CHARACTER'\s*\)/,
    );
    assert.match(workerSource, /slide\.getNotesPage\(\)/);
    assert.match(workerSource, /'notes': notes/);
  });

  it('reads the non-empty notes shape and clears duplicate note placeholders', () => {
    assert.match(workerSource, /shape\.getShapeType\(\) == 'com\.sun\.star\.presentation\.NotesShape'/);
    assert.match(workerSource, /for shape in note_shapes\(notes_page\):[\s\S]+?if notes:\n\s+return notes/);
    assert.match(workerSource, /for candidate in existing_shapes:\n\s+candidate\.String = ''/);
  });

  it('clears stored Word header and footer text before disabling them', () => {
    assert.match(workerSource, /else:\n\s+if page_style\.HeaderIsOn:\n\s+page_style\.HeaderText\.String = ''/);
    assert.match(workerSource, /else:\n\s+if page_style\.FooterIsOn:\n\s+page_style\.FooterText\.String = ''/);
  });

  it('includes Word table cells in content returned to the Agent', () => {
    assert.match(workerSource, /document\.TextTables/);
    assert.match(workerSource, /'tables': tables/);
  });

  it('applies Excel text color to each cell text cursor for OOXML persistence', () => {
    assert.match(workerSource, /cell\.CharColor = text_color/);
    assert.match(workerSource, /cell_cursor = cell\.createTextCursor\(\)/);
    assert.match(workerSource, /cell_cursor\.CharColorTheme = -1/);
    assert.match(workerSource, /cell_cursor\.CharColor = text_color/);
  });

  it('returns Excel range styles so the Agent can verify formatting', () => {
    assert.match(workerSource, /'styles': style_summary/);
  });

  it('loads again when the engine answers with no document at all', () => {
    // Accepting on the pipe is not the same as being ready to load: a desktop
    // that is still coming up returns a null component and raises nothing, and
    // the operation failed with "could not open the document" over a file that
    // opens perfectly the next moment.
    assert.match(workerSource, /for attempt in range\(LOAD_ATTEMPTS\)/);
    assert.match(workerSource, /if document is not None:\n\s+return document/);
    assert.match(workerSource, /raise RuntimeError\('LibreOffice could not open the document'\)/);
  });

  it('never lets closing the document decide whether the operation failed', () => {
    // Both close paths raise intermittently on a document the engine has
    // already torn down, and an escaped exception there threw away a result
    // that had been stored — the operation reported "illegal object given!"
    // for work it had finished.
    assert.match(
      workerSource,
      /def close_document\(document\):[\s\S]+?document\.close\(True\)\n\s+except Exception:\n\s+try:\n\s+document\.dispose\(\)\n\s+except Exception:\n\s+pass/,
    );
  });

  it('waits for LibreOffice as long as the Node side is willing to', () => {
    // The bridge used to give up after a fixed 300 × 0.1s while the Node side
    // was still willing to wait two minutes, so a slow start — several
    // instances coming up at once, which is what back-to-back tool calls
    // produce — failed outright instead of merely taking longer.
    const budget = /CONNECT_TIMEOUT_SECONDS = (\d+)/.exec(workerSource);
    assert.ok(budget, 'the bridge names its connection budget');
    const runnerSource = fs.readFileSync(path.join(root, 'electron', 'office', 'unoRunner.cjs'), 'utf8');
    const timeout = Number(/UNO_TIMEOUT_MS = (\d+)/.exec(runnerSource)[1]);
    assert.ok(
      Number(budget[1]) * 1000 < timeout,
      'the bridge must give up before the process that is waiting on it',
    );
    assert.ok(Number(budget[1]) >= 30, 'and not before a loaded machine can start');
    // The runner starts a fresh instance after a refusal, so the user waits
    // this once per attempt before hearing that nothing worked. The ceiling is
    // three minutes rather than two because of a measurement: when LibreOffice
    // crashes, macOS holds the next start behind its crash reporter, and the
    // one after a crash took 133 seconds against a 120-second budget. Failing
    // 13 seconds short of an instance that was coming up is the worst of both.
    const attempts = Number(/ACCEPTOR_ATTEMPTS = (\d+)/.exec(runnerSource)[1]);
    assert.ok(Number(budget[1]) * attempts <= 180, 'every attempt together must still answer inside three minutes');
    assert.ok(Number(budget[1]) * attempts >= 150, 'and must outlast a start held up by a crash report');
  });

  it('draws a worksheet chart the way it was asked for, beside its data', () => {
    // BarDiagram.Vertical means "bars run horizontally", so a column chart is
    // Vertical=False. The deck composer had it right and the worksheet chart had
    // it inverted, which turned every requested column chart into a bar chart.
    const orientations = workerSource.match(/diagram\.Vertical = chart_type == '(\w+)'/g) || [];
    assert.equal(orientations.length, 2, 'both chart paths set the orientation');
    assert.deepEqual([...new Set(orientations)].length, 1, 'and they must agree');
    assert.match(workerSource, /diagram\.Vertical = chart_type == 'bar'/);

    // Anchored to the data instead of a constant corner: a fixed rectangle at
    // the top left drops every chart on top of the table it describes.
    assert.match(workerSource, /rectangle\.X = int\(anchor\.Position\.X\)/);
    assert.doesNotMatch(workerSource, /rectangle\.X = 1000/);
  });

  it('leaves ratio columns out of a composed table\'s totals row', () => {
    // Three months at 62% do not add up to 187%. Summing whatever has a number
    // format catches the percentage columns too, and the reader bounces on it.
    assert.match(workerSource, /if '%' in code:\n\s+continue/);
  });

  it('composes a whole Word document in one call, styled through the style family', () => {
    assert.match(workerSource, /'word_compose':/);
    assert.match(workerSource, /WORD_THEMES = \{/);
    // Restyling the named styles is what a heading actually is: the navigator,
    // the table of contents and the PDF bookmarks all read the style. Formatting
    // each paragraph instead leaves a document that only looks like it has
    // headings, and the user finds out when they generate the contents page.
    assert.match(workerSource, /ParagraphStyles/);
    assert.match(workerSource, /com\.sun\.star\.text\.ContentIndex/);
    assert.match(workerSource, /com\.sun\.star\.text\.TextField\.PageNumber/);
  });

  it('composes a presentable deck with no picture file and no configuration', () => {
    // Most installations will never have a picture provider configured, so the
    // deck has to stand up without one. Three things decide whether it does,
    // and none of them needs an asset, a key or a network call.

    // An image slide with nothing to place draws a themed figure rather than
    // silently collapsing into one more bullet list.
    assert.match(workerSource, /def theme_figure\(/);
    assert.match(workerSource, /theme_figure\(\s*document, slide/);

    // Content is centred in its band. Top-anchored text in a fixed band is what
    // leaves the bottom half of every slide empty — the single thing that makes
    // a generated deck look generated.
    assert.match(workerSource, /TextVerticalAdjust/);

    // A long CJK headline is stepped down instead of running into the subtitle.
    assert.match(workerSource, /def fitted_size\(/);
    assert.match(workerSource, /def text_weight\(/);
  });
});
