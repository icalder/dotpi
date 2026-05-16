import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let sessionApproved = false;
  const approvedPaths = new Set<string>();

  // Matches "rm" as a standalone command word followed by space (flags or filenames).
  // \b ensures we don't match "arm", "remove", etc.
  // Requires trailing whitespace so "rm" alone without arguments won't match.
  const rmPattern = /\brm\b/;

  pi.on("session_shutdown", async () => {
    sessionApproved = false;
    approvedPaths.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash") {
      return;
    }

    if (sessionApproved) return;

    let shouldPrompt = false;
    let detail = "";
    let targetPath = "";

    if (isToolCallEventType("write", event)) {
      shouldPrompt = true;
      detail = `write the file "${event.input.path}"`;
      targetPath = event.input.path;
    } else if (isToolCallEventType("edit", event)) {
      shouldPrompt = true;
      detail = `edit the file "${event.input.path}"`;
      targetPath = event.input.path;
    } else if (isToolCallEventType("bash", event) && rmPattern.test(event.input.command)) {
      shouldPrompt = true;
      detail = `run a file deletion command (rm)`;
    }

    if (shouldPrompt) {
      // Allow previously approved paths (per-call approval)
      if (targetPath && approvedPaths.has(targetPath)) {
        return;
      }

      if (!ctx.hasUI) {
        // Allow by default in non-interactive mode (-p, JSON, RPC).
        // Blocking here would silently break CI/CD pipelines and scripted
        // workflows where the agent is expected to write files autonomously.
        // Users who want hard blocking in headless mode should not enable
        // this extension in those environments.
        return;
      }

      const choice = await ctx.ui.select(
        `Filesystem Change Requested\n\nThe agent wants to ${detail}.\n\nChoose an action:`,
        ["Allow this one", "Allow all for this session", "Deny"],
      );

      if (choice === "Deny") {
        ctx.ui.notify("Filesystem change blocked by user", "warning");
        return { block: true, reason: "Filesystem change blocked by user" };
      }

      if (choice === "Allow this one") {
        if (targetPath) {
          approvedPaths.add(targetPath);
        }
        return;
      }

      // "Allow all for this session"
      sessionApproved = true;
    }
  });
}
