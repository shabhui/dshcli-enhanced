const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const os = require("node:os");

const legacy = Buffer.from("com.termux");
const relocated = Buffer.from("com.dshcli");
const managers = ["apt", "apt-get", "dpkg", "dpkg-deb"];
const rewrite = (value) => value.replaceAll("com.termux", "com.dshcli");

function run(command, args, { descriptors = [], ...options } = {}) {
  const stdio = [0, 1, 2];
  for (const fd of descriptors) {
    if (!Number.isInteger(fd) || fd < 0 || fd > 1024) throw new Error("Invalid dpkg descriptor");
    while (stdio.length <= fd) stdio.push("ignore");
    stdio[fd] = fd;
  }
  const result = spawnSync(command, args, { stdio, ...options });
  if (result.error) throw result.error;
  return result;
}

function checked(command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.signal || result.status})`);
}

function relocateFile(file) {
  // Retain an overlap so strings crossing a read boundary are replaced once.
  const fd = fs.openSync(file, "r+");
  const block = Buffer.alloc(1024 * 1024 + legacy.length - 1);
  try {
    let position = 0;
    let size;
    while ((size = fs.readSync(fd, block, 0, block.length, position)) > 0) {
      const bytes = block.subarray(0, size);
      let offset = 0;
      let changed = false;
      while ((offset = bytes.indexOf(legacy, offset)) !== -1) {
        relocated.copy(bytes, offset);
        offset += legacy.length;
        changed = true;
      }
      if (changed) fs.writeSync(fd, bytes, 0, size, position);
      if (size < block.length) break;
      position += size - legacy.length + 1;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function relocateTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const original = path.join(directory, entry.name);
    const target = path.join(directory, rewrite(entry.name));
    if (original !== target) {
      if (fs.existsSync(target)) throw new Error(`Relocation path collision: ${target}`);
      fs.renameSync(original, target);
    }
    if (entry.isSymbolicLink()) {
      const before = fs.readlinkSync(target);
      const after = rewrite(before);
      if (before !== after) {
        fs.unlinkSync(target);
        fs.symlinkSync(after, target);
      }
    } else if (entry.isDirectory()) {
      relocateTree(target);
    } else if (entry.isFile()) {
      relocateFile(target);
    }
  }
}

function wrapper(tool, prefix) {
  if (!managers.includes(tool) || !/^\/[a-zA-Z0-9_./-]+$/.test(prefix)) throw new Error("Invalid package-manager path");
  return `#!/system/bin/sh\n# DSHA package relocation wrapper\nexec "${prefix}/libexec/dsha-runtime/node" "${prefix}/libexec/dsha-runtime/dsha-dpkg-relocate.js" ${tool} "$@"\n`;
}

function refreshChecksums(tree) {
  const sums = [];
  function visit(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (name === "DEBIAN") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, name);
      else if (entry.isFile()) {
        const digest = createHash("md5");
        const fd = fs.openSync(file, "r");
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          let size;
          while ((size = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, size));
        } finally { fs.closeSync(fd); }
        sums.push(`${digest.digest("hex")}  ${name}`);
      }
    }
  }
  visit(tree);
  fs.writeFileSync(path.join(tree, "DEBIAN/md5sums"), sums.sort().join("\n") + "\n");
}

function relocateDeb(archive, directory, dpkgDeb, prefix) {
  fs.mkdirSync(directory, { recursive: true });
  const tree = path.join(directory, "tree");
  const output = path.join(directory, "relocated.deb");
  checked(dpkgDeb, ["--raw-extract", path.resolve(archive), tree]);
  relocateTree(tree);
  // A package-manager upgrade must install its new binary behind the wrapper.
  for (const tool of managers) {
    const binary = path.join(tree, prefix, "bin", tool);
    if (!fs.existsSync(binary)) continue;
    if (fs.readFileSync(binary).includes(Buffer.from("# DSHA package relocation wrapper\n"))) continue;
    const destination = path.join(tree, prefix, "libexec/dsha-runtime", tool);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(binary, destination);
    fs.writeFileSync(binary, wrapper(tool, prefix), { mode: 0o755 });
  }
  refreshChecksums(tree);
  // gzip works with both the older bootstrap dpkg and current repository dpkg.
  checked(dpkgDeb, ["-Zgzip", "-z1", "--build", tree, output], { stdio: ["ignore", 2, 2] });
  return output;
}

function isDeb(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const fd = fs.openSync(file, "r");
  try {
    const magic = Buffer.alloc(8);
    return fs.readSync(fd, magic) === 8 && magic.equals(Buffer.from("!<arch>\n"));
  } finally { fs.closeSync(fd); }
}

function parseOptions(tool, args) {
  const valueOptions = new Set([
    "--root", "--admindir", "--instdir", "--log", "--status-fd", "--status-logger",
    "--command-fd", "--command-logger", "--abort-after", "--pre-invoke", "--post-invoke",
    "--path-exclude", "--path-include", "--ignore-depends", "--debug", "--force", "--refuse",
    "--no-force", "--verify-format", "--showformat", "--deb-format", "--compression",
    "--compression-level", "--compression-strategy", "--threads-max",
  ]);
  const commands = tool === "dpkg" ? ["--install", "--unpack"]
    : ["--extract", "--vextract", "--raw-extract", "--control", "--fsys-tarfile", "--ctrl-tarfile"];
  const operands = new Set();
  const normalized = [...args];
  const descriptors = [];
  let install = false;
  let recursive = false;
  let options = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (options && arg === "--") { options = false; continue; }
    if (!options || !arg.startsWith("-") || arg === "-") { operands.add(index); continue; }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.split(/=(.*)/s);
      if (commands.includes(name)) install = true;
      if (tool === "dpkg" && name === "--recursive") {
        recursive = true;
        normalized[index] = null;
      }
      const value = valueOptions.has(name) && inline === undefined ? args[++index] : inline;
      if (name === "--status-fd" || name === "--command-fd") descriptors.push(Number(value));
    } else {
      for (let offset = 1; offset < arg.length; offset++) {
        const letter = arg[offset];
        if ((tool === "dpkg" ? "D" : "zZSt").includes(letter)) {
          if (offset === arg.length - 1) index++;
          break;
        }
        if ((tool === "dpkg" ? "i" : "xXRe").includes(letter)) install = true;
        if (tool === "dpkg" && letter === "R") {
          recursive = true;
          normalized[index] = normalized[index].replace("R", "");
          if (normalized[index] === "-") normalized[index] = null;
        }
      }
    }
  }
  // dpkg-deb's second operand is an extraction destination, never an input archive.
  if (tool === "dpkg-deb" && operands.size > 1) return { install, recursive, descriptors, normalized, operands: new Set([operands.values().next().value]) };
  return { install, recursive, descriptors, normalized, operands };
}

function main(tool, args) {
  if (!managers.includes(tool)) throw new Error(`Unknown package manager: ${tool}`);
  const prefix = process.env.PREFIX || "/data/data/com.dshcli/files/usr";
  const realRoot = path.join(prefix, "libexec/dsha-runtime");
  if (tool === "apt" || tool === "apt-get") {
    return run(path.join(realRoot, tool), ["-o", `Dir::Bin::dpkg=${prefix}/bin/dpkg`, ...args]);
  }
  const { descriptors, install, recursive, operands, normalized } = parseOptions(tool, args);
  if (!install) return run(path.join(realRoot, tool), args, { descriptors });
  const tmp = path.join(prefix, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(tmp, "dsha-deb-"));
  try {
    const nestedRoot = process.env.DSHA_RELOCATED_DEB_ROOT;
    let count = 0;
    function convert(arg) {
      const absolute = path.resolve(arg);
      if (nestedRoot && absolute.startsWith(nestedRoot + path.sep)) return arg;
      if (recursive && fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
        return fs.readdirSync(arg).filter((name) => !name.startsWith(".")).flatMap((name) => {
          const child = path.join(arg, name);
          return fs.lstatSync(child).isDirectory() || child.endsWith(".deb") ? convert(child) : [];
        });
      }
      if (!isDeb(arg)) return arg;
      return relocateDeb(arg, path.join(temporary, String(count++)), path.join(realRoot, "dpkg-deb"), prefix);
    }
    const converted = normalized.flatMap((arg, index) => arg === null ? [] : operands.has(index) ? convert(arg) : arg);
    return run(path.join(realRoot, tool), converted, {
      descriptors,
      env: { ...process.env, DSHA_RELOCATED_DEB_ROOT: temporary },
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { relocateTree, relocateDeb, run, main };
if (require.main === module) {
  try {
    const result = main(process.argv[2], process.argv.slice(3));
    process.exitCode = result.status ?? (128 + (os.constants.signals[result.signal] || 1));
  } catch (error) {
    console.error(`DSHA package relocation: ${error.message}`);
    process.exitCode = 1;
  }
}
