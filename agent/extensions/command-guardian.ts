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
        const ok = await ctx.ui.confirm(
          "Dangerous Command Detected!",
          `Do you want to proceed with: \n\`${command}\`?`
        );
        
        if (!ok) {
          return { block: true, reason: "Command blocked by Command Guardian extension" };
        }
      }
    }
  });
}
