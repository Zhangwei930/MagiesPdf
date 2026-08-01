import type { LocalizedText, ToolOutputFile } from '@core/types.ts';
import type { AiArtifact, AiEvent } from '../bridge.ts';

export type { AiEvent } from '../bridge.ts';

export interface AiToolActivity {
  callId: string;
  toolId: string;
  toolName?: LocalizedText;
  inputFileNames: string[];
  status: 'running' | 'done' | 'error';
  fraction: number;
  details?: string;
  error?: string;
}

export interface AiWorkflowStep {
  callId: string;
  toolId: string;
  toolName?: LocalizedText;
  details?: string;
}

export interface AiApproval {
  approvalId: string;
  toolId: string;
  toolName: LocalizedText;
  inputFileNames: string[];
  details?: string;
}

export interface AiTurnState {
  requestId: string;
  assistantText: string;
  workflow: AiWorkflowStep[];
  tools: AiToolActivity[];
  approvals: AiApproval[];
  artifacts: AiArtifact[];
}

export interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  workflow?: AiWorkflowStep[];
  tools?: AiToolActivity[];
  artifacts?: ToolOutputFile[];
  error?: boolean;
}

export function createTurnState(requestId: string): AiTurnState {
  return { requestId, assistantText: '', workflow: [], tools: [], approvals: [], artifacts: [] };
}

function updateTool(
  tools: AiToolActivity[],
  callId: string,
  patch: Partial<AiToolActivity>,
): AiToolActivity[] {
  return tools.map((tool) => (tool.callId === callId ? { ...tool, ...patch } : tool));
}

export function applyAiEvent(state: AiTurnState, event: AiEvent): AiTurnState {
  if (event.requestId !== state.requestId) return state;

  switch (event.type) {
    case 'assistant_delta':
      return { ...state, assistantText: state.assistantText + event.delta };
    case 'assistant_done':
      return { ...state, assistantText: event.content };
    case 'workflow_preview':
      return { ...state, workflow: event.steps };
    case 'tool_start':
      return {
        ...state,
        tools: [
          ...state.tools,
          {
            callId: event.callId,
            toolId: event.toolId,
            toolName: event.toolName,
            inputFileNames: event.inputFileNames,
            status: 'running',
            fraction: 0,
            details: event.details,
          },
        ],
      };
    case 'tool_progress':
      return {
        ...state,
        tools: updateTool(state.tools, event.callId, { fraction: event.fraction }),
      };
    case 'tool_result':
      return {
        ...state,
        tools: updateTool(state.tools, event.callId, {
          status: event.ok ? 'done' : 'error',
          fraction: event.ok ? 1 : 0,
          error: event.error,
        }),
        artifacts: event.ok && event.files
          ? [...state.artifacts, ...event.files]
          : state.artifacts,
      };
    case 'approval_required':
      return {
        ...state,
        approvals: [
          ...state.approvals,
          {
            approvalId: event.approvalId,
            toolId: event.toolId,
            toolName: event.toolName,
            inputFileNames: event.inputFileNames ?? [],
            details: event.details,
          },
        ],
      };
    case 'approval_cleared':
      return {
        ...state,
        approvals: state.approvals.filter((approval) => approval.approvalId !== event.approvalId),
      };
    default:
      return state;
  }
}
