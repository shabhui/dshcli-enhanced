'use strict';
// Android/arm64 placeholder for koffi's native module.
//
// koffi publishes one prebuilt per platform as @koromix/koffi-<platform>-<arch>
// and has no Android entry, so `import koffi from "koffi"` throws at module load
// time on this platform. Two kernel packages import it at the top level even
// though every koffi *call* they make sits behind a `process.platform === "win32"`
// guard:
//
//   @deepseek-ai/dsh-subprocess-local     kernel32.dll / PROCESSENTRY32W / FILETIME
//   @deepseek-ai/dsh-win32-process        STARTUPINFOW / PROCESS_INFORMATION
//     (reached from @deepseek-ai/dsh-sandbox-local via dsh-sandbox-windows-acl)
//
// Both also assert struct layouts at module scope, so returning inert zero-sized
// types is not enough. This module therefore implements the part of koffi that is
// pure arithmetic — C struct layout under natural alignment with LP64 primitive
// sizes, which is what a real koffi build on arm64 computes — and makes every
// operation that needs an actual FFI engine throw with an explicit message.
//
// Nothing here emulates FFI. If Android ever reaches a koffi call, it fails loudly.

const VERSION = '3.1.5';

// LP64 primitive sizes (Android arm64). Alignment equals size for these.
const PRIMITIVES = {
  void: [0, 0, 'Void'],
  bool: [1, 1, 'Bool'],
  char: [1, 1, 'Int8'], uchar: [1, 1, 'UInt8'],
  int8: [1, 1, 'Int8'], uint8: [1, 1, 'UInt8'],
  char16: [2, 2, 'Int16'], char16_t: [2, 2, 'Int16'],
  short: [2, 2, 'Int16'], ushort: [2, 2, 'UInt16'],
  int16: [2, 2, 'Int16'], uint16: [2, 2, 'UInt16'],
  int: [4, 4, 'Int32'], uint: [4, 4, 'UInt32'],
  int32: [4, 4, 'Int32'], uint32: [4, 4, 'UInt32'],
  long: [8, 8, 'Int64'], ulong: [8, 8, 'UInt64'],
  longlong: [8, 8, 'Int64'], ulonglong: [8, 8, 'UInt64'],
  int64: [8, 8, 'Int64'], uint64: [8, 8, 'UInt64'],
  intptr: [8, 8, 'Int64'], uintptr: [8, 8, 'UInt64'],
  size_t: [8, 8, 'UInt64'], ssize_t: [8, 8, 'Int64'],
  float: [4, 4, 'Float32'], float32: [4, 4, 'Float32'],
  double: [8, 8, 'Float64'], float64: [8, 8, 'Float64'],
  // pointer-shaped string aliases
  str: [8, 8, 'Pointer'], string: [8, 8, 'Pointer'],
  str16: [8, 8, 'Pointer'], string16: [8, 8, 'Pointer'],
  str32: [8, 8, 'Pointer'], string32: [8, 8, 'Pointer'],
};

const registry = new Map();
let anon = 0;

function make(primitive, name, size, alignment, extra) {
  const t = Object.assign(
    { name, primitive, size, alignment, members: {}, __koffiAndroidPlaceholder: true },
    extra || {}
  );
  if (name) registry.set(name, t);
  return t;
}

// Resolve a type spec (string name or type object) to a type object.
function resolve(spec) {
  if (spec && typeof spec === 'object') {
    if (spec.__koffiAndroidPlaceholder) return spec;
    throw new TypeError('Unexpected type specification');
  }
  const name = String(spec);
  const hit = registry.get(name);
  if (hit) return hit;
  const p = PRIMITIVES[name];
  if (p) return make(p[2] === 'Pointer' ? 'Pointer' : p[2], name, p[0], p[1]);
  // Unknown names are treated as opaque pointers, matching how koffi handles
  // handle-ish typedefs; a wrong guess surfaces as a layout-guard failure
  // rather than silently miscomputing a size.
  return make('Opaque', name, 8, 8);
}

const align = (offset, a) => (a > 0 ? Math.ceil(offset / a) * a : offset);

function record(primitive, args) {
  const [name, members] = typeof args[0] === 'string' ? [args[0], args[1]] : [undefined, args[0]];
  const out = {};
  let offset = 0;
  let maxAlign = 1;
  for (const key of Object.keys(members || {})) {
    const t = resolve(members[key]);
    maxAlign = Math.max(maxAlign, t.alignment || 1);
    const at = primitive === 'Union' ? 0 : align(offset, t.alignment || 1);
    out[key] = { name: key, type: t, offset: at };
    offset = primitive === 'Union' ? Math.max(offset, t.size) : at + t.size;
  }
  const size = align(offset, maxAlign);
  return make(primitive, name || `<anonymous ${primitive} ${++anon}>`, size, maxAlign, { members: out });
}

function unavailable(name) {
  return function () {
    throw new Error(
      `koffi.${name}() is not available on ${process.platform}-${process.arch}: no native ` +
        'koffi build exists for Android. This placeholder only computes type layouts so ' +
        'packages whose koffi use is confined to Windows-only code paths can be imported.'
    );
  };
}

const pointer = (...args) => {
  const ref = resolve(args.length > 1 && typeof args[0] === 'string' ? args[1] : args[0]);
  const named = args.length > 1 && typeof args[0] === 'string' ? args[0] : undefined;
  return make('Pointer', named || `${ref.name} *`, 8, 8, { ref });
};
const array = (ref, len) => {
  const t = resolve(ref);
  return make('Array', `${t.name}[${len}]`, t.size * Number(len), t.alignment, { ref: t, len: Number(len) });
};
const alias = (name, ref) => {
  const t = resolve(ref);
  return make(t.primitive, name, t.size, t.alignment, { ref: t, members: t.members });
};
const opaque = (name) => make('Opaque', name || `<opaque ${++anon}>`, 0, 1);
const proto = (...args) =>
  make('Prototype', typeof args[0] === 'string' ? args[0] : `<prototype ${++anon}>`, 8, 8);

module.exports = {
  version: VERSION,

  // validated / wrapped by koffi's wrapNative()
  load: unavailable('load'),
  register: unavailable('register'),
  introspect: resolve,
  type: resolve,

  // layout description — pure arithmetic, safe at import time
  struct: (...args) => record('Record', args),
  pack: (...args) => record('Record', args),
  union: (...args) => record('Union', args),
  pointer,
  array,
  alias,
  opaque,
  handle: opaque,
  proto,
  callback: proto,
  disposable: (...args) => alias(typeof args[0] === 'string' ? args[0] : `<disposable ${++anon}>`, args[args.length - 1]),

  // anything that needs real memory or real code
  alloc: unavailable('alloc'),
  free: unavailable('free'),
  encode: unavailable('encode'),
  decode: unavailable('decode'),
  address: unavailable('address'),
  as: unavailable('as'),
  call: unavailable('call'),
  unregister: unavailable('unregister'),
  reset: unavailable('reset'),
  errno: unavailable('errno'),
  os: unavailable('os'),
  stats: () => ({}),
  config: () => ({}),

  // lets a diagnostic tell a placeholder from a real build
  __koffiAndroidPlaceholder: true,
};

