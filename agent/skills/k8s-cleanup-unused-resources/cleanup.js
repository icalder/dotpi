import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

/**
 * Kustomize uses a custom encoding for its hash suffixes.
 * It takes the first 10 characters of the SHA256 hex string and
 * performs a character substitution.
 */
function kustomizeEncode(hex) {
  const enc = hex.substring(0, 10).split('');
  for (let i = 0; i < enc.length; i++) {
    switch (enc[i]) {
      case '0': enc[i] = 'g'; break;
      case '1': enc[i] = 'h'; break;
      case '3': enc[i] = 'k'; break;
      case 'a': enc[i] = 'm'; break;
      case 'e': enc[i] = 't'; break;
    }
  }
  return enc.join('');
}

/**
 * Deterministically stringifies an object with sorted keys to match Go's json.Marshal.
 */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  const sortedKeys = Object.keys(obj).sort();
  return '{' + sortedKeys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',') + '}';
}

/**
 * Replicates Kustomize's hashing logic to verify if a resource name 
 * ends with its legitimate Kustomize-generated suffix.
 */
function verifyKustomizeSuffix(type, name, resource) {
  const parts = name.split('-');
  const suffix = parts[parts.length - 1];
  
  // We need to reconstruct the object Kustomize hashes.
  // For ConfigMap: {kind: "ConfigMap", name: "", data: <data>, [binaryData: <binaryData>]}
  // For Secret: {kind: "Secret", type: <type>, name: "", data: <data>, [stringData: <stringData>]}
  // Note: Kustomize hashes with name set to "" for resources generated with a suffix.
  let m = {
    kind: type,
    name: "",
  };

  if (type === 'ConfigMap') {
    m.data = resource.data === undefined ? "" : resource.data;
    if (resource.binaryData && Object.keys(resource.binaryData).length > 0) {
      m.binaryData = resource.binaryData;
    }
  } else if (type === 'Secret') {
    m.type = resource.type === undefined ? "" : resource.type;
    m.data = resource.data === undefined ? "" : resource.data;
    if (resource.stringData && Object.keys(resource.stringData).length > 0) {
      m.stringData = resource.stringData;
    }
  } else {
    return false;
  }

  // Use stable stringification to match Go's json.Marshal behavior
  const jsonStr = stableStringify(m);
  const hash = crypto.createHash('sha256').update(jsonStr).digest('hex');
  const expectedSuffix = kustomizeEncode(hash);

  return suffix === expectedSuffix;
}

function runCommand(command, args = []) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 60000, // 60s timeout per command
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`kubectl not found in PATH. Install it or update your PATH.`);
    }
    throw result.error;
  }

  if (result.status !== 0) {
    const error = new Error(
      `Command failed: ${command} ${args.join(' ')}${result.stderr ? `\nStderr: ${result.stderr}` : ''}`
    );
    // @ts-ignore
    error.status = result.status;
    // @ts-ignore
    error.stderr = result.stderr;
    // @ts-ignore
    error.stdout = result.stdout;
    throw error;
  }

  return result.stdout;
}

/**
 * Collect all string values from a Kubernetes resource object.
 * Walks the object recursively, collecting every leaf string value.
 */
function collectStringValues(obj) {
  const strings = new Set();
  const stack = [obj];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (typeof current === 'string') {
      strings.add(current);
    } else if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (typeof current === 'object') {
      for (const key of Object.keys(current)) {
        stack.push(current[key]);
      }
    }
  }
  return strings;
}

async function main() {
  const args = process.argv.slice(2);
  const namespaceIdx = args.indexOf('--namespace');
  const namespace = args[namespaceIdx + 1];

  // Permissive regex to catch potential Kustomize resources
  const pattern = /^[a-z0-9-]+-[a-z0-9]{8,12}$/;

  const targets = [];
  
  try {
    const cmOutput = runCommand('kubectl', ['get', 'configmap', '-n', namespace, '-o', 'json']);
    const cmData = JSON.parse(cmOutput);
    for (const item of cmData.items || []) {
        if (pattern.test(item.metadata.name)) {
            targets.push({type: 'ConfigMap', name: item.metadata.name, resource: item});
        }
    }

    const secOutput = runCommand('kubectl', ['get', 'secret', '-n', namespace, '-o', 'json']);
    const secData = JSON.parse(secOutput);
    for (const item of secData.items || []) {
        if (pattern.test(item.metadata.name)) {
            targets.push({type: 'Secret', name: item.metadata.name, resource: item});
        }
    }
  } catch (e) {
      console.error(e.message);
      process.exit(1);
  }

  if (targets.length === 0) {
    console.log('No candidate Kustomize resources found in namespace.');
    process.exit(0);
  }

  const RELEVANT_TYPES = ['pods', 'deployments', 'daemonsets', 'statefulsets', 'replicasets', 'serviceaccounts', 'ingresses', 'podtemplates'];
  const usedNames = new Set();

  for (const resourceType of RELEVANT_TYPES) {
    let output;
    try {
      output = runCommand('kubectl', ['get', resourceType, '-n', namespace, '-o', 'json']);
    } catch (error) {
      continue;
    }
    try {
      const data = JSON.parse(output);
      const items = data.items || [];
      const namesReferencedByThisType = new Set();

      for (const item of items) {
        if (resourceType === 'replicasets') {
          const replicas = item.spec?.replicas ?? 0;
          if (replicas === 0) continue;
          const hasActiveOwner = item.metadata?.ownerReferences?.some(
            (ref) => ref.controller === true
          );
          if (!hasActiveOwner) continue;
        }

        for (const val of collectStringValues(item)) {
          namesReferencedByThisType.add(val);
        }
      }

      for (const target of targets) {
        if (!usedNames.has(target.name) && namesReferencedByThisType.has(target.name)) {
          usedNames.add(target.name);
        }
      }
    } catch (parseError) {
      continue;
    }
  }

  const unusedTargets = targets.filter((t) => !usedNames.has(t.name));

  if (unusedTargets.length === 0) {
    console.log('All Kustomize resources are referenced by active workloads.');
    process.exit(0);
  }

  // Final safety check: Verify the suffix is actually a Kustomize hash
  const verifiedUnused = unusedTargets.filter(t => verifyKustomizeSuffix(t.type, t.name, t.resource));

  if (verifiedUnused.length === 0) {
    console.log('No verified Kustomize resources found for cleanup.');
    process.exit(0);
  }

  console.log(`\nFound ${verifiedUnused.length} unused Kustomize resource(s). Execute the following commands to delete them:`);
  for (const t of verifiedUnused) {
    console.log(`kubectl delete ${t.type.toLowerCase()} ${t.name} -n ${namespace}`);
  }
}

main();
