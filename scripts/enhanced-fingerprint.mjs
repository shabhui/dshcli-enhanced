import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function filesUnder(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(root, absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

export function fingerprintDirectory(directory) {
  const root = path.resolve(directory);
  const hash = createHash("sha256");
  for (const absolute of filesUnder(root)) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const invokedDirectly = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const directory = process.argv[2] || path.dirname(fileURLToPath(import.meta.url));
  try {
    process.stdout.write(`${fingerprintDirectory(directory)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
