/** Extra Panelavo approval is reserved for actions beyond routine site work. */
export function requiresMcpConfirmation(tool: string, args: unknown): boolean {
  if (
    [
      "panelavo_execute_terminal_command",
      "panelavo_deploy_site",
      "panelavo_deploy_artifact_release",
    ].includes(tool)
  )
    return false;

  if (tool !== "panelavo_manage_site_section") return true;
  const input = args as
    | { section?: string; operation?: { action?: string; mode?: string } }
    | undefined;
  const action = input?.operation?.action;
  if (input?.section === "terminal" && action === "exec") return false;
  if (input?.section !== "file-manager" || !action) return true;
  if (action === "paste") return input.operation?.mode !== "copy";
  return ![
    "list",
    "read",
    "upload",
    "save-file",
    "new-file",
    "new-folder",
    "duplicate",
    "compress",
    "extract",
  ].includes(action);
}
