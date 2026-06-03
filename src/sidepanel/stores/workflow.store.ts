/**
 * Workflow Store — manages workflow list and execution
 */
import { writable, derived } from 'svelte/store';

export interface Workflow {
  id: string;
  name: string;
  description: string;
  nodes: number;
  status: 'draft' | 'ready' | 'running' | 'completed' | 'error';
  last_run?: string;
  created_at: string;
}

export interface WorkflowState {
  workflows: Workflow[];
  isLoading: boolean;
}

function createWorkflowStore() {
  const { subscribe, update } = writable<WorkflowState>({ workflows: [], isLoading: false });

  return {
    subscribe,

    async load() {
      update(s => ({ ...s, isLoading: true }));
      try {
        const response = await chrome.runtime.sendMessage({ type: 'WORKFLOW_LIST' });
        if (response.success) {
          update(s => ({ ...s, workflows: response.workflows || [], isLoading: false }));
        } else {
          update(s => ({ ...s, isLoading: false }));
        }
      } catch {
        update(s => ({ ...s, isLoading: false }));
      }
    },

    async create(name: string, description: string) {
      const response = await chrome.runtime.sendMessage({
        type: 'WORKFLOW_CREATE',
        payload: { name, description },
      });
      if (response.success && response.workflow) {
        update(s => ({ ...s, workflows: [response.workflow, ...s.workflows] }));
      }
      return response;
    },

    async run(workflowId: string) {
      update(s => ({
        ...s,
        workflows: s.workflows.map(w =>
          w.id === workflowId ? { ...w, status: 'running' as const } : w
        ),
      }));
      await chrome.runtime.sendMessage({
        type: 'WORKFLOW_RUN',
        payload: { id: workflowId },
      });
    },

    async deleteWorkflow(workflowId: string) {
      await chrome.runtime.sendMessage({
        type: 'WORKFLOW_DELETE',
        payload: { id: workflowId },
      });
      update(s => ({ ...s, workflows: s.workflows.filter(w => w.id !== workflowId) }));
    },

    openEditor(workflowId: string) {
      chrome.runtime.sendMessage({
        type: 'WORKFLOW_OPEN_EDITOR',
        payload: { id: workflowId },
      });
    },
  };
}

export const workflowStore = createWorkflowStore();
export const workflows = derived(workflowStore, $s => $s.workflows);
