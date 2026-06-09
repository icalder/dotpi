// credit: https://github.com/vossenwout/pookie-dotfiles/blob/main/pi/.pi/agent/extensions/done-bell.ts

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.hasPendingMessages()) return;
    process.stdout.write("\x07");
  });
}