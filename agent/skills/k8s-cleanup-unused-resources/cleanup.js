import { execSync } from 'child_process';
import fs from 'fs';
import readline from 'readline';

/**
 * Run a kubectl command and return stdout.
 * FAIL-CLOSED: Any non-zero exit code throws an error.
 */
function runCommand(command, args = []) {
  try {
    const result = execSync(`${command} ${args.join(' ')}`, {
      encoding: 'utf8',
      timeout: 60000, // 60s timeout per command
    });
    return result;
  } catch (error) {
    // Fail-closed: propagate the error so the caller can abort
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}\n` +
      `Exit code: ${error.status ?? 'N/A'}\n` +
      `Stderr: ${error.stderr?.toString() ?? 'N/A'}\n` +
      `Stdout: ${error.stdout?.toString() ?? 'N/A'}`
    );
  }
}

/**
 * Collect all string values from a Kubernetes resource object.
 * Walks the object recursively, collecting every leaf string value
 * and every key used in the object.
 */
function collectStrings(obj) {
  const strings = new Set();
  const stack = [obj];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (typeof current === 'string') {
      strings.add(current);
      continue;
    }
    if (typeof current === 'object') {
      if (Array.isArray(current)) {
        for (const item of current) stack.push(item);
      } else {
        for (const key of Object.keys(current)) {
          strings.add(key);
          stack.push(current[key]);
        }
      }
    }
  }
  return strings;
}

/**
 * Check whether a target resource name is referenced in a Kubernetes resource.
 *
 * A resource is considered to reference a target if:
 *   - The target name appears as a value in the resource's data (e.g., configMapKeyRef.name,
 *     secretKeyRef.name, volume.name, serviceAccount, imagePullSecrets, etc.)
 *   - The target name appears in ownerReferences
 *   - The target name appears in annotations or labels (less common, but possible)
 *
 * We use exact-match checking on string values rather than regex to avoid false positives
 * from partial string matches (e.g., "my-config-abc" matching "my-config-abc-def").
 */
function isReferenced(targetName, item) {
  const strings = collectStrings(item);

  // Exact match: the target name appears as a standalone string value or key
  if (strings.has(targetName)) {
    return true;
  }

  // Also check for the name appearing as a substring in meaningful fields.
  // We only do this for fields known to hold resource references to avoid false positives.
  const referenceFields = [
    'name', 'namespace', 'configMapKeyRef', 'secretKeyRef', 'serviceAccountName',
    'serviceAccount', 'volume', 'volumes', 'configMap', 'secret',
    'imagePullSecrets', 'service', 'endpoint', 'host',
    'ownerReferences', 'annotations', 'labels', 'env', 'envFrom',
    'args', 'command', 'value', 'valueFrom',
    'source', 'items', 'keys', 'defaultMode',
  ];

  // Walk the object and check reference fields for the target name
  function walkForReferences(obj, path = '') {
    if (obj === null || obj === undefined) return false;
    if (typeof obj === 'string') {
      return obj === targetName;
    }
    if (typeof obj === 'object') {
      if (Array.isArray(obj)) {
        return obj.some((item) => walkForReferences(item, path));
      }
      const keys = Object.keys(obj);
      for (const key of keys) {
        const currentPath = path ? `${path}.${key}` : key;
        // If this key is a known reference field, check its value(s)
        if (referenceFields.includes(key)) {
          const value = obj[key];
          if (typeof value === 'string' && value === targetName) {
            return true;
          }
          if (typeof value === 'object' && value !== null) {
            // e.g., configMapKeyRef: { name: "foo" }
            if (value.name === targetName) {
              return true;
            }
            // Recurse into the object to find nested references
            if (walkForReferences(value, currentPath)) {
              return true;
            }
          }
        }
        // Recurse into all fields regardless
        if (walkForReferences(obj[key], currentPath)) {
          return true;
        }
      }
    }
    return false;
  }

  return walkForReferences(item);
}

async function main() {
  const args = process.argv.slice(2);
  const namespaceIdx = args.indexOf('--namespace');

  if (namespaceIdx === -1 || !args[namespaceIdx + 1]) {
    console.log('Usage: node cleanup.js --namespace <namespace> [--dry-run]');
    process.exit(1);
  }

  const namespace = args[namespaceIdx + 1];
  const dryRun = args.includes('--dry-run');

  const pattern = /.*-[a-z0-9]+$/;

  console.log(`Scanning namespace: ${namespace}`);

  // ── 1. Get all namespaced resource types ──────────────────────────────
  console.log('Fetching namespaced resource types...');
  let apiResourcesOutput;
  try {
    apiResourcesOutput = runCommand('kubectl', ['api-resources', '--namespaced=true', '--no-headers']);
  } catch (error) {
    console.error(`FATAL: Could not fetch API resources. Aborting to prevent unsafe deletions.`);
    console.error(error.message);
    process.exit(1);
  }

  if (!apiResourcesOutput?.trim()) {
    console.error('FATAL: Empty response from kubectl api-resources. Aborting.');
    process.exit(1);
  }

  const resourceTypes = apiResourcesOutput
    .trim()
    .split('\n')
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);

  // ── 2. Get target resources (ConfigMaps and Secrets) matching the pattern ──
  console.log('Finding candidate ConfigMaps and Secrets...');
  const targets = [];

  const targetTypes = ['configmap', 'secret'];
  for (const type of targetTypes) {
    try {
      const output = runCommand('kubectl', ['get', type, '-n', namespace, '-o', 'json']);
      const data = JSON.parse(output);
      if (data.items) {
        for (const item of data.items) {
          const name = item.metadata.name;
          if (pattern.test(name)) {
            targets.push({ type, name });
          }
        }
      }
    } catch (error) {
      console.error(
        `FATAL: Failed to fetch ${type} resources in namespace "${namespace}". Aborting to prevent unsafe deletions.`
      );
      console.error(error.message);
      process.exit(1);
    }
  }

  if (targets.length === 0) {
    console.log('No matching ConfigMaps or Secrets found.');
    process.exit(0);
  }

  console.log(`Found ${targets.length} candidate resources matching the pattern.`);

  // Whitelist of resource types that can actually reference ConfigMaps or Secrets.
  // Checking every namespaced resource type is wasteful — most (Endpoints, Events,
  // LimitRanges, ResourceQuotas, NetworkPolicies, etc.) cannot reference CMs/Secrets.
  const RELEVANT_TYPES = new Set([
    'pods',
    'deployments',
    'daemonsets',
    'statefulsets',
    'jobs',
    'cronjobs',
    'replicasets',
    'replicationcontrollers',
    'serviceaccounts',
    'podtemplates',
    'ingresses',
  ]);

  // ── 3. Find which of these are used ──────────────────────────────────
  const relevantTypes = resourceTypes.filter(
    (rt) => !['configmap', 'secret'].includes(rt) && RELEVANT_TYPES.has(rt)
  );
  console.log(`Checking for references in ${relevantTypes.length} relevant resource type(s)...`);
  const usedNames = new Set();

  // Process each relevant resource type individually to handle unavailable API resources gracefully
  let checkedCount = 0;
  for (const resourceType of resourceTypes) {
    // Skip non-relevant resource types
    if (!RELEVANT_TYPES.has(resourceType)) continue;
    // Skip the targets themselves
    if (resourceType === 'configmap' || resourceType === 'secret') continue;

    let output;
    try {
      output = runCommand('kubectl', ['get', resourceType, '-n', namespace, '-o', 'json']);
    } catch (error) {
      // Check if this is a "NotFound" or "MethodNotAllowed" error for an unavailable API resource
      const stderr = error.message || '';
      if (
        stderr.includes('the server could not find the requested resource') ||
        stderr.includes('the server does not allow this method on the requested resource')
      ) {
        // This resource type is not available in this cluster — skip it
        continue;
      }
      // Genuine error (auth, connectivity, etc.) — abort
      console.error(
        `FATAL: Failed to query resource type "${resourceType}" in namespace "${namespace}". ` +
        `Aborting to prevent unsafe deletions.`
      );
      console.error(error.message);
      process.exit(1);
    }

    if (!output?.trim()) continue;

    try {
      const data = JSON.parse(output);
      const items = data.items || [];

      for (const item of items) {
        // --- NEW: Skip inactive ReplicaSets ---
        if (resourceType === 'replicasets') {
          const replicas = item.spec?.replicas ?? 0;
          if (replicas === 0) continue;
        }

        // Check each target against this resource
        for (const target of targets) {
          if (usedNames.has(target.name)) continue;
          if (isReferenced(target.name, item)) {
            usedNames.add(target.name);
          }
        }
      }
      checkedCount++;
    } catch (parseError) {
      // Fail-closed: if we can't parse the response, abort
      console.error(
        `FATAL: Failed to parse JSON response from kubectl for resource type "${resourceType}". ` +
        `Aborting to prevent unsafe deletions.`
      );
      console.error(parseError.message);
      process.exit(1);
    }
  }

  console.log(`Checked ${checkedCount} relevant resource type(s) for references.`);

  // ── 4. Identify unused ones ──────────────────────────────────────────
  const unusedTargets = targets.filter((t) => !usedNames.has(t.name));

  if (unusedTargets.length === 0) {
    console.log('No unused resources found.');
    process.exit(0);
  }

  console.log(`\nFound ${unusedTargets.length} unused resources:`);
  unusedTargets.forEach((t) => {
    console.log(`  [${t.type}] ${t.name}`);
  });

  // ── 5. Pre-deletion verification ─────────────────────────────────────
  console.log('\nVerifying resources still exist before deletion...');
  const verifiedTargets = [];
  let verificationFailed = false;

  for (const t of unusedTargets) {
    try {
      const output = runCommand('kubectl', ['get', t.type, t.name, '-n', namespace, '-o', 'json']);
      const data = JSON.parse(output);
      // Resource exists — verify it's the same one we identified
      if (data.metadata?.name === t.name) {
        verifiedTargets.push(t);
      } else {
        console.warn(`  WARNING: ${t.type}/${t.name} exists but name mismatch. Skipping.`);
        verificationFailed = true;
      }
    } catch (error) {
      // Resource no longer exists — it was already deleted by something else
      console.warn(`  WARNING: ${t.type}/${t.name} no longer exists. Skipping.`);
      verificationFailed = true;
    }
  }

  if (verifiedTargets.length === 0) {
    console.log('\nNo resources verified for deletion. Cleanup cancelled.');
    process.exit(0);
  }

  console.log(`\n${verifiedTargets.length} resources verified for deletion.`);

  if (dryRun) {
    console.log('\n[DRY RUN] No resources were deleted.');
    process.exit(0);
  }

  // ── 6. User confirmation ─────────────────────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise((resolve) =>
    rl.question('Are you sure you want to delete these resources? (y/N): ', resolve)
  );
  rl.close();

  if (answer.toLowerCase() !== 'y') {
    console.log('Cleanup cancelled.');
    process.exit(0);
  }

  // ── 7. Delete ────────────────────────────────────────────────────────
  let deletionErrors = 0;
  for (const t of verifiedTargets) {
    try {
      console.log(`Deleting ${t.type}/${t.name}...`);
      runCommand('kubectl', ['delete', t.type, t.name, '-n', namespace]);
      console.log(`  Deleted successfully.`);
    } catch (error) {
      console.error(`  ERROR: Failed to delete ${t.type}/${t.name}`);
      console.error(`  ${error.message}`);
      deletionErrors++;
    }
  }

  if (deletionErrors > 0) {
    console.log(`\nCleanup completed with ${deletionErrors} error(s).`);
    process.exit(1);
  }

  console.log('\nCleanup complete.');
}

main();
