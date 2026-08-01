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
    assert.match(ipcSource, /ai:workspaceStatus/);
    assert.match(ipcSource, /ai:pickWorkspace/);
    assert.match(ipcSource, /ai:clearWorkspace/);
    assert.match(ipcSource, /properties:\s*\['openDirectory'\]/);
  });

  it('exposes only status, explicit folder selection, and clear actions to the renderer', () => {
    assert.match(preloadSource, /getAiWorkspaceStatus/);
    assert.match(preloadSource, /pickAiWorkspace/);
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
    assert.match(workerSource, /'presentation_delete_slide':/);
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
});
