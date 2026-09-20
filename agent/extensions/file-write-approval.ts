import { resolve } from "node:path";

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

/**
 * Approves file writes and edits. Destructive shell commands are handled by
 * command-guardian.ts, which knows which paths are disposable.
 *
 * Configuration (environment, no edit of this file needed):
 *   PI_SANDBOX=1  disable the approval prompts (set by agent-sandbox)
 */

/** "1" or "true" disables the prompts; set by the agent sandbox. */
const SANDBOX_ENV = "PI_SANDBOX";

export default function (pi: ExtensionAPI) {
  // Inside the agent sandbox the sandbox is the safety net, so the
  // per-write prompts would only add friction.
  const sandbox = process.env[SANDBOX_ENV]?.trim().toLowerCase();
  if (sandbox === "1" || sandbox === "true") return;

  let sessionApproved = false;
  const approvedPaths = new Set<string>();

  pi.on("session_shutdown", async () => {
    sessionApproved = false;
    approvedPaths.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    const target = describeWriteTarget(event);
    if (!target) return;

    if (sessionApproved) return;
    if (approvedPaths.has(target.path)) return;

    if (!ctx.hasUI) {
      // Allow by default in non-interactive mode (-p, JSON, RPC).
      // Blocking here would silently break CI/CD pipelines and scripted
      // workflows where the agent is expected to write files autonomously.
      // Users who want hard blocking in headless mode should not enable
      // this extension in those environments.
      return;
    }

    const choice = await ctx.ui.select(
      `Filesystem Change Requested\n\nThe agent wants to ${target.detail}.\n\nChoose an action:`,
      ["Allow this one", "Allow all for this session", "Deny"],
    );

    if (choice === "Allow this one") {
      approvedPaths.add(target.path);
      return;
    }

    // "Allow all for this session"
    if (choice === "Allow all for this session") {
      sessionApproved = true;
      return;
    }

    // Explicit Deny, or a dismissed dialog: nothing was approved.
    ctx.ui.notify("Filesystem change blocked by user", "warning");
    return { block: true, reason: "Filesystem change blocked by user" };
  });
}

/**
 * What the agent wants to change, or null when the tool does not write files.
 * The path is absolute, so `./notes.md` and `<cwd>/notes.md` share one approval.
 */
function describeWriteTarget(event: ToolCallEvent): { path: string; detail: string } | null {
  if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
    const verb = event.toolName === "write" ? "write" : "edit";
    const path = resolve(event.input.path);
    return { path, detail: `${verb} the file "${path}"` };
  }
  return null;
}
