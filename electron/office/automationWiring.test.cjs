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
