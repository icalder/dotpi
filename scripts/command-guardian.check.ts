/**
 * Unit checks for the command guardian policy.
 * Run with: scripts/test.sh   (or: node scripts/command-guardian.check.ts)
 * Needs Node 22.13 or newer, which strips the TypeScript types itself.
 */
import { createSuite } from "./test-kit.mjs";

// The module reads the environment while it loads, so overrides from the
// developer's shell must be gone before the import below.
delete process.env.PI_GUARDIAN_SAFE_DELETE_PATHS;
delete process.env.PI_GUARDIAN_ALLOW_RECURSIVE;

const guardian = await import("../agent/extensions/command-guardian.ts");
const {
  createCommandGuard,
  requiresConfirmation,
  SafeDeletionZone,
  allowRecursiveInSafePaths,
  safeDeletePrefixes,
} = guardian;

const suite = createSuite("command-guardian");

/** Commands whose answer must be `expected`, in the default configuration. */
const cases: ReadonlyArray<readonly [string, boolean]> = [
  // scratch paths, the whole point of the extension
  ["rm /tmp/*", false],
  ["rm -f /tmp/*", false],
  ["rm -f /tmp/foo.txt", false],
  ["rm -f /var/tmp/build/*.o", false],
  ["rm -f /tmp/a /tmp/b", false],
  ["rm -f /tmp/a \\\n/tmp/b", false],

  // flags: long forms, `--`, and non-recursive directory removal
  ["rm -f -- /tmp/foo", false],
  ["rm --force /tmp/x", false],
  ["rm -d /tmp/foo", false],
  ["rm --dir /tmp/foo", false],

  // `..` inside a name is not traversal
  ["rm -f /tmp/foo..bar", false],
  ["rm -f /tmp/my..file.txt", false],
  ["rm -f /tmp/file...bak", false],

  // wrappers that do not change the command
  ["sudo rm -f /tmp/*", false],
  ["doas rm -f /tmp/*", false],
  ["time rm -f /tmp/*", false],
  ["env rm -f /tmp/*", false],
  ["env TMPDIR=/scratch rm -f /tmp/*", true],

  // chains: every statement must be safe on its own
  ["cd /tmp && rm -f /tmp/*", false],
  ["rm -f /tmp/x && rm -f /var/tmp/y", false],
  ["rm -f /tmp/* ; echo done", false],
  ["rm -f /tmp/x && rm -f /home/me/secrets.txt", true],

  // other deleters
  ["unlink /tmp/x", false],
  ["shred -n 1 /tmp/x", false],
  ["find /tmp -name '*.o'", false],
  ["unlink /etc/passwd", true],
  ["shred ~/secrets.txt", true],

  // commands that are not deletions at all
  ["armadillo --clean", false],
  ["ls -la /tmp", false],
  ["git status", false],

  // deleter names used as flags, e.g. `podman compose run --rm`
  ["podman compose run --rm someimage", false],
  ["docker compose run --rm someimage", false],
  ["docker run --rm someimage", false],
  ["podman run --rm -it someimage bash", false],
  ["podman compose run --rm --entrypoint wp auto-install eval 'echo hi'", false],
  ["echo --rm file", false],
  ["echo --unlink /tmp/x", false],
  // recursive removal keeps prompting by default
  ["rm -rf /tmp/*", true],
  ["rm -r /tmp/*", true],
  ["rm -R /tmp/x", true],
  ["rm --recursive /tmp/x", true],
  ["rm -rf /", true],
  ["sudo rm -rf /etc", true],

  // leaving the scratch prefix, by path or by syntax
  ["rm -f /tmp/../etc/passwd", true],
  ["rm /tmp", true],
  ["rm /tmp/", true],
  ["rm /tmpfoo/x", true],
  ["rm -f ./tmp/*", true],
  ["rm -f ~/tmp/*", true],
  ["rm -f /tmp/a /etc/passwd", true],
  ["rm -f -- /etc/passwd", true],
  ["rm -f $TMPDIR/x", true],
  ["rm -f $(ls /tmp)", true],
  ["rm -$FLAG /tmp/x", true],

  // a `find` mentioned in another command's arguments is not a find command,
  // even when the `$( ... | ... )` substitution is split into its own fragment
  ["grep -n x $(find . -name '*.h' | head -1)", false],
  ["cd /home/itcalde/speech-processing/handy-transcribe/transcribe.cpp && find . -name \"wav.h\" -not -path \"./build/*\" | head -3 && grep -n \"rate\\|resample\\|48000\\|16000\" $(find . -name \"wav.h\" -not -path \"./build/*\" | head -1) | head -20", false],
  // ...but a `-delete` spelled behind another program still asks
  ["echo find /tmp -delete", true],
  ["bash -c 'find / -delete'", true],

  // shapes that cannot be read stay noisy
  ["rm", true],
  ["rm -", true],
  ["rm -f /tmp/a -- -weird", true],
  ["bash -c 'rm -rf /'", true],
  ["echo rm file", true],
  ["git rm -rf /tmp/x", true],
  ["find /tmp -name '*.o' | xargs rm -f", true],

  // git history writes
  ["git commit -m x", true],
  ["git push origin main", true],

  // `find -delete` descends, so it waits for the recursive opt-out
  ["find /tmp/build -name '*.o' -delete", true],
  ["find / -name '*.log' -delete", true],
  ["find -delete", true],
  ["find /tmp/x -name '*.o' -exec rm {} ;", true],
];

for (const [command, expected] of cases) {
  suite.expect(command, requiresConfirmation(command), expected);
}

/* ----------------------------------------------------------- safe deletion */

const scratch = new SafeDeletionZone(["/tmp/", "/var/tmp/"]);
const zoneCases: ReadonlyArray<readonly [string, boolean]> = [
  ["/tmp/a", true],
  ["/var/tmp/a.o", true],
  ["/tmp/a..b", true],
  ["/tmp", false],
  ["/tmp/", false],
  ["/tmpfoo/x", false],
  ["/etc/passwd", false],
  ["/tmp/../etc/passwd", false],
  ["/tmp/a/../b", false],
  ["/tmp/$X", false],
  ["/tmp/`id`", false],
  ["/tmp/a\\b", false],
];

for (const [path, expected] of zoneCases) {
  suite.expect(`zone contains ${path}`, scratch.contains(path), expected);
}

/* ------------------------------------------------------------ custom guards */

const recursiveGuard = createCommandGuard({ allowRecursiveInSafePaths: true });
const customPrefixGuard = createCommandGuard({
  safeDeletePrefixes: ["/custom/"],
  allowRecursiveInSafePaths: false,
});

const guardCases: ReadonlyArray<readonly [string, string, boolean]> = [
  ["recursive allowed", "rm -rf /tmp/*", false],
  ["recursive allowed", "rm -rf /etc", true],
  ["recursive allowed", "find /tmp/build -delete", false],
  ["recursive allowed", "find / -delete", true],
  ["recursive allowed", "find /tmp/x -L -delete", true],
  ["recursive allowed", "find /tmp/x -exec rm {} ; -delete", true],
  ["custom prefix", "rm -f /custom/x", false],
  ["custom prefix", "rm -f /tmp/x", true],
];

for (const [label, command, expected] of guardCases) {
  const guard = label === "recursive allowed" ? recursiveGuard : customPrefixGuard;
  suite.expect(`${label}: ${command}`, guard.offender(command) !== null, expected);
}

/* --------------------------------------------------------------- env config */

function withEnv(name: string, value: string | undefined, body: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const pathsCases: ReadonlyArray<readonly [string, string]> = [
  ["unset", "/tmp/:/var/tmp/"],
  ["/custom", "/custom/"],
  ["/custom/", "/custom/"],
  ["/tmp/::/var/tmp/", "/tmp/:/var/tmp/"],
  ["/tmp/:bad:/", "/tmp/"],
  ["/", "/tmp/:/var/tmp/"],
  ["   ", "/tmp/:/var/tmp/"],
  ["relative/dir", "/tmp/:/var/tmp/"],
];

for (const [value, expected] of pathsCases) {
  withEnv("PI_GUARDIAN_SAFE_DELETE_PATHS", value === "unset" ? undefined : value, () => {
    suite.expect(`PI_GUARDIAN_SAFE_DELETE_PATHS=${value}`, safeDeletePrefixes().join(":"), expected);
  });
}

const recursiveCases: ReadonlyArray<readonly [string | undefined, boolean]> = [
  [undefined, false],
  ["1", true],
  ["true", true],
  ["TRUE", true],
  ["0", false],
  ["", false],
];

for (const [value, expected] of recursiveCases) {
  withEnv("PI_GUARDIAN_ALLOW_RECURSIVE", value, () => {
    suite.expect(
      `PI_GUARDIAN_ALLOW_RECURSIVE=${value ?? "<unset>"}`,
      allowRecursiveInSafePaths(),
      expected,
    );
  });
}

withEnv("PI_GUARDIAN_SAFE_DELETE_PATHS", "/custom", () => {
  const guard = createCommandGuard();
  suite.expect("env prefix allows /custom/x", guard.offender("rm -f /custom/x") !== null, false);
  suite.expect("env prefix still asks for /tmp/x", guard.offender("rm -f /tmp/x") !== null, true);
});

suite.finish();
