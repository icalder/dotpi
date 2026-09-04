/**
 * Integration checks for both extensions together.
 * Replays tool_call events through the handlers, the way ExtensionRunner does,
 * and counts the dialogs the user would see.
 * Run with: scripts/test.sh   (or: node scripts/extensions-smoke.mjs)
 */
import { createSuite } from "./test-kit.mjs";
import { loadExtensionModule } from "./load-extension.mjs";

const EXTENSION_PATHS = [
  "../agent/extensions/command-guardian.ts",
  "../agent/extensions/file-write-approval.ts",
];

const handlers = [];
const register = { on: (event, handler) => handlers.push({ event, handler }) };
for (const path of EXTENSION_PATHS) {
  const extension = await loadExtensionModule(path);
  extension.default(register);
}

const prompts = [];
const answers = { confirm: false, select: "Deny", hasUI: true };

const ctx = {
  get hasUI() {
    return answers.hasUI;
  },
  ui: {
    confirm: async (title) => {
      prompts.push(`confirm(${title.match(/\(([^)]+)\)/)?.[1] ?? title})`);
      return answers.confirm;
    },
    select: async (title) => {
      prompts.push(`select(${title.split("\n")[0]})`);
      return answers.select === "<dismissed>" ? undefined : answers.select;
    },
    notify: () => {},
  },
};

/** A fresh session, so approvals from a previous scenario do not leak. */
async function startSession() {
  for (const { event, handler } of handlers) {
    if (event === "session_shutdown") await handler({});
  }
}

/** Runs one tool call per loaded handler, and reports dialogs plus the verdict. */
async function run(events) {
  await startSession();
  prompts.length = 0;

  let blocked = false;
  for (const event of events) {
    for (const { event: name, handler } of handlers) {
      if (name !== "tool_call") continue;
      const result = await handler(event, ctx);
      if (result?.block) blocked = true;
      if (blocked) break;
    }
  }

  return { promptCount: prompts.length, blocked, prompts: [...prompts] };
}

const bash = (command) => ({ toolName: "bash", toolCallId: "1", input: { command } });
const write = (path) => ({ toolName: "write", toolCallId: "2", input: { path, content: "x" } });
const edit = (path) => ({ toolName: "edit", toolCallId: "3", input: { path, edits: [] } });
const read = (path) => ({ toolName: "read", toolCallId: "4", input: { path } });

const suite = createSuite("extensions smoke");

/** Single bash command: how many dialogs does the user see? */
const commandCases = [
  ["rm /tmp/*", 0],
  ["rm -f /tmp/*", 0],
  ["rm -f /var/tmp/build/a.o", 0],
  ["rm -f -- /tmp/foo", 0],
  ["sudo rm -f /tmp/*", 0],
  ["unlink /tmp/x", 0],
  ["ls -la /tmp", 0],
  ["rm -rf /tmp/*", 1],
  ["rm -rf /", 1],
  ["rm -f /home/me/secrets.txt", 1],
  ["rm -f /tmp/a /etc/passwd", 1],
  ["unlink /etc/passwd", 1],
  ["find /tmp/build -delete", 1],
  ["git push origin main", 1],
  ["bash rm", 1],
  ["podman compose run --rm someimage", 0],
  ["docker run --rm someimage", 0],
];

for (const [command, expectedPrompts] of commandCases) {
  const outcome = await run([bash(command)]);
  suite.expect(`bash ${command} prompts`, outcome.promptCount, expectedPrompts);
}

/** File tools: read is never a write, write and edit always are. */
const fileCases = [
  [write("/tmp/out.txt"), "write /tmp/out.txt", 1],
  [edit("/tmp/out.txt"), "edit /tmp/out.txt", 1],
  [read("/tmp/out.txt"), "read /tmp/out.txt", 0],
];

for (const [event, label, expectedPrompts] of fileCases) {
  const outcome = await run([event]);
  suite.expect(label, outcome.promptCount, expectedPrompts);
}

/** A denied dialog blocks the tool call, an accepted one lets it through. */
answers.confirm = false;
suite.expect("rm -rf / blocked after deny", (await run([bash("rm -rf /")])).blocked, true);
answers.confirm = true;
suite.expect("rm -rf / allowed after confirm", (await run([bash("rm -rf /")])).blocked, false);

answers.select = "Deny";
suite.expect("write blocked after deny", (await run([write("/tmp/a.txt")])).blocked, true);
answers.select = "<dismissed>";
suite.expect("write blocked when dialog dismissed", (await run([write("/tmp/a.txt")])).blocked, true);

/** Without UI nothing is asked and nothing is blocked: headless runs continue. */
answers.hasUI = false;
const headlessCases = [
  [bash("rm -rf /"), "headless rm -rf /"],
  [bash("git push origin main"), "headless git push"],
  [write("/etc/hosts"), "headless write /etc/hosts"],
];

for (const [event, label] of headlessCases) {
  const outcome = await run([event]);
  suite.expect(`${label} prompts`, outcome.promptCount, 0);
  suite.expect(`${label} blocked`, outcome.blocked, false);
}
answers.hasUI = true;

/** Approvals are remembered per path, then for the whole session. */
answers.confirm = true;

answers.select = "Allow this one";
suite.expect(
  "allow one: dialogs for /tmp/a then /tmp/a then /tmp/b",
  (await run([write("/tmp/a.txt"), write("/tmp/a.txt"), write("/tmp/b.txt")])).promptCount,
  2,
);
suite.expect(
  "allow one: edit of an approved path is not asked again",
  (await run([write("/tmp/c.txt"), edit("/tmp/c.txt")])).promptCount,
  1,
);

answers.select = "Allow all for this session";
suite.expect(
  "allow all: dialogs for /tmp/a then /tmp/a then /tmp/b",
  (await run([write("/tmp/a.txt"), write("/tmp/a.txt"), write("/tmp/b.txt")])).promptCount,
  1,
);
suite.expect(
  "session write approval does not silence the guardian",
  (await run([write("/tmp/a.txt"), bash("rm -rf /tmp/*")])).promptCount,
  2,
);

suite.finish();
