'use strict';

const INTERACTIVE_ONLY_TOOL_IDS = new Set(['office:macro:run']);

function requiresInteractiveApproval(toolId) {
  return INTERACTIVE_ONLY_TOOL_IDS.has(String(toolId));
}

module.exports = {
  INTERACTIVE_ONLY_TOOL_IDS,
  requiresInteractiveApproval,
};
