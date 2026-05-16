import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command;
      
      // Check for rm, git commit, or git push
      // Using regex \brm\b to ensure we don't match words like 'arm'
      const isDangerous = /\brm\b/.test(command) || 
                         command.includes("git commit") || 
                         command.includes("git push");

      if (isDangerous) {
        if (!ctx.hasUI) {
          // Allow by default in non-interactive mode (-p, JSON, RPC).
          // Blocking here would silently break CI/CD pipelines and scripted
          // workflows where the agent is expected to run commands autonomously.
          // Users who want hard blocking in headless mode should not enable
          // this extension in those environments.
          return;
        }

        const ok = await ctx.ui.confirm(
          "Dangerous Command Detected!",
          `Do you want to proceed with: \n\`${command}\`?`
        );
        
        if (!ok) {
          ctx.ui.notify("Command blocked by Command Guardian extension", "warning");
          return { block: true, reason: "Command blocked by Command Guardian extension" };
        }
      }
    }
  });
}
