/**
 * Minimal assertion kit shared by the extension check scripts.
 * A failing expectation prints and sets a non-zero exit code at the end.
 */
export function createSuite(name) {
  let passed = 0;
  const failures = [];

  return {
    /** Records one comparison. `label` names the input, e.g. the shell command. */
    expect(label, actual, expected) {
      const ok = actual === expected;
      if (ok) passed++;
      else failures.push(`${label}: got ${show(actual)}, want ${show(expected)}`);
      if (!ok) {
        console.log(`FAIL ${label}  actual=${show(actual)} want=${show(expected)}`);
      }
      return ok;
    },

    /** Prints the totals and marks the process failed when something failed. */
    finish() {
      if (failures.length > 0) {
        console.log(`\n${name}: ${failures.length} failing case(s)`);
        for (const failure of failures) console.log(`  ${failure}`);
        process.exitCode = 1;
        return;
      }
      console.log(`\n${name}: all ${passed} cases pass`);
    },
  };
}

function show(value) {
  return typeof value === "string" ? value : String(value);
}
