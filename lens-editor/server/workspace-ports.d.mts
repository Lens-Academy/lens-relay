export interface WorkspaceIdentity {
  number: number;
  suffix: string;
  suffixOffset: number;
  label: string;
}

export interface WorkspacePorts {
  workspace: WorkspaceIdentity;
  vite: number;
  relay: number;
  discordBridge: number;
  utilityBase: number;
}

export function parseWorkspaceName(name: string): WorkspaceIdentity;
export function getWorkspacePorts(name: string): WorkspacePorts;
export function getWorkspacePortsFromPaths(projectName: string, parentName: string): WorkspacePorts;
