'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const ipcSource = fs.readFileSync(path.join(root, 'electron', 'ipc.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');

describe('AI automation wiring', () => {
  it('owns the rule store and starts and stops one automation engine with the app', () => {
    assert.match(ipcSource, /createAutomationStore/);
    assert.match(ipcSource, /createAutomationEngine/);
    assert.match(ipcSource, /ai-automations\.json/);
    assert.match(ipcSource, /automationEngine\.start\(\)/);
    assert.match(ipcSource, /automationEngine\.stop\(\)/);
  });

  it('exposes only narrow rule and queue operations to the renderer', () => {
    for (const channel of [
      'ai:automationState',
      'ai:automationCreate',
      'ai:automationSetEnabled',
      'ai:automationDelete',
      'ai:automationResolvePending',
    ]) {
      assert.match(ipcSource, new RegExp(channel));
    }
    assert.match(preloadSource, /getAiAutomationState/);
    assert.match(preloadSource, /createAiAutomationRule/);
    assert.match(preloadSource, /setAiAutomationRuleEnabled/);
    assert.match(preloadSource, /deleteAiAutomationRule/);
    assert.match(preloadSource, /resolveAiAutomationPending/);
    assert.match(preloadSource, /onAiAutomationEvent/);
    assert.doesNotMatch(preloadSource, /runAiUnattended|ai:runUnattended/);
  });
});
