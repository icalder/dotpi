/**
 * Loads a TypeScript pi extension from a plain Node script.
 *
 * Node 22.13+ strips types natively, which is the normal path. On older Node
 * the script falls back to the jiti copy bundled with the installed pi
 * package, found by walking up from that package instead of a hard coded path.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL(".", import.meta.url));

/** Import the module at `specifier` (relative to this file or absolute). */
export async function loadExtensionModule(specifier) {
  const url = pathToFileURL(resolve(here, specifier)).href;
  try {
    return await import(url);
  } catch (error) {
    if (error?.code !== "ERR_UNKNOWN_FILE_EXTENSION") throw error;
    return await (await jiti()).import(url);
  }
}

async function jiti() {
  try {
    return await import("jiti");
  } catch {
    // Not a dependency of this project: use the copy installed with pi.
  }

  const anchors = [tryRequireResolve("@earendil-works/pi-coding-agent"), import.meta.url];
  for (const anchor of anchors) {
    if (!anchor) continue;
    const found = findUp(dirname(fileURLToPath(anchor)), join("node_modules", "jiti", "lib", "jiti.mjs"));
    if (found) return import(pathToFileURL(found).href);
  }

  throw new Error("Cannot load TypeScript: use Node 22.13 or newer, or install jiti.");
}

function tryRequireResolve(specifier) {
  try {
    return require.resolve(specifier);
  } catch {
    return null;
  }
}

function findUp(startDirectory, relativeTarget) {
  let directory = startDirectory;
  while (true) {
    const candidate = join(directory, relativeTarget);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
