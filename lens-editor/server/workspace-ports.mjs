const WORKSPACE_PATTERN = /(?:^ws|-ws)(\d+)([a-z])?$/;

export function parseWorkspaceName(name) {
  const match = name.match(WORKSPACE_PATTERN);
  const number = match ? Number.parseInt(match[1], 10) : 1;
  const suffix = match?.[2] ?? '';
  const suffixOffset = suffix ? suffix.charCodeAt(0) - 96 : 0;

  return {
    number,
    suffix,
    suffixOffset,
    label: `ws${number}${suffix}`,
  };
}

export function getWorkspacePorts(name) {
  const workspace = parseWorkspaceName(name);
  const persistentOffset = (workspace.number - 1) * 100;
  const ephemeralOffset = workspace.suffixOffset;

  return {
    workspace,
    vite: 5173 + persistentOffset + ephemeralOffset,
    relay: 8090 + persistentOffset + ephemeralOffset,
    discordBridge: 8050 + persistentOffset + ephemeralOffset,
    utilityBase: 9100 + persistentOffset,
  };
}

export function getWorkspacePortsFromPaths(projectName, parentName) {
  const projectWorkspace = parseWorkspaceName(projectName);
  if (WORKSPACE_PATTERN.test(projectName)) {
    return getWorkspacePorts(projectName);
  }
  if (WORKSPACE_PATTERN.test(parentName)) {
    return getWorkspacePorts(parentName);
  }
  return getWorkspacePorts(projectWorkspace.label);
}
