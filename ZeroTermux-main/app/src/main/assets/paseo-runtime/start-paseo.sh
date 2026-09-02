#!/system/bin/sh
set -u

RUN_ID="${1:?Missing Paseo run id}"
PORT="${2:-6767}"
APP_DIR="$HOME/.paseo-app"
AGENTS_BIN="$APP_DIR/agents/bin"
RUNTIME_DIR="$APP_DIR/runtime"
STATUS_FILE="$APP_DIR/status-$RUN_ID"
STARTUP_LOG="$APP_DIR/paseo-startup.log"
ENHANCED_MARKER="$APP_DIR/enhanced-fingerprint"
BUNDLED_FINGERPRINT_FILE="$RUNTIME_DIR/asset-fingerprint"
TOYBOX="/system/bin/toybox"
NODE="$PREFIX/bin/node"
DAEMON_WORKER="$PREFIX/lib/node_modules/@getpaseo/server/dist/server/server/daemon-worker.js"
DAEMON_PID=""
PASEO_BASE_SYSTEM_PROMPT_FILE="$APP_DIR/android-agent-environment.txt"

"$TOYBOX" mkdir -p "$APP_DIR"
"$TOYBOX" mkdir -p "$AGENTS_BIN"
PATH="$AGENTS_BIN:$PREFIX/bin:/system/bin:/system/xbin"
export PATH

write_status() {
    "$TOYBOX" printf '%s\n%s\n%s\n' "$RUN_ID" "$1" "$2" > "$STATUS_FILE.tmp"
    "$TOYBOX" mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

log() {
    timestamp="$("$TOYBOX" date '+%Y-%m-%dT%H:%M:%S%z')"
    "$TOYBOX" printf '[%s] %s\n' "$timestamp" "$*"
}

fail() {
    log "ERROR: $1"
    write_status error "$1"
    exit 1
}

case "$PORT" in
    ""|*[!0-9]*) fail "Paseo 端口无效：$PORT" ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ] || [ "$PORT" -eq 6768 ]; then
    fail "Paseo 端口无效：$PORT"
fi

stop_daemon() {
    if [ -z "$DAEMON_PID" ]; then
        return
    fi
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
    DAEMON_PID=""
}

trap stop_daemon EXIT INT TERM

is_paseo_ready() {
    "$TOYBOX" nc -z -w 1 127.0.0.1 "$PORT" >/dev/null 2>&1
}

wait_for_paseo() {
    attempt=0
    while [ "$attempt" -lt 180 ]; do
        if is_paseo_ready; then
            return 0
        fi
        if [ -n "$DAEMON_PID" ] && ! kill -0 "$DAEMON_PID" 2>/dev/null; then
            wait "$DAEMON_PID"
            daemon_exit=$?
            DAEMON_PID=""
            fail "Paseo 服务在就绪前退出（exit $daemon_exit）"
        fi
        attempt=$((attempt + 1))
        "$TOYBOX" sleep 0.5
    done
    fail "Paseo 启动超时（已等待 90 秒）"
}

: > "$STARTUP_LOG"
exec >>"$STARTUP_LOG" 2>&1
log "Paseo startup begin: run=$RUN_ID"
log "HOME=$HOME"
log "PREFIX=$PREFIX"
log "runtime=$RUNTIME_DIR"
log "daemon-worker.js=$DAEMON_WORKER"
log "Paseo port=$PORT"
NODE_VERSION="$("$NODE" --version 2>&1 || true)"
log "node --version: $NODE_VERSION"
write_status installing "正在准备内置 Paseo 运行环境"

log "Running install-bundled-runtime.sh"
"$RUNTIME_DIR/install-bundled-runtime.sh" || fail "运行环境安装失败"
log "Bundled runtime installation completed"

# Probe what is actually installed instead of asserting a fixed list. A stale claim is
# worse than no claim: an Agent told "git is available" wastes a turn discovering it is not,
# and the set changes as soon as the user runs pkg install or adds a CLI.
detect_commands() {
    detected=""
    missing=""
    for candidate in \
        sh bash node npm codex paseo claude pi opencode \
        git curl wget pkg apt dpkg tar unzip gzip xz \
        grep sed awk find diff patch nano vim less \
        ps top pgrep pkill logcat am pm getprop \
        python python3 pip jq rg fd make cmake clang gcc \
        ssh openssl termux-setup-storage termux-open-url
    do
        if command -v "$candidate" >/dev/null 2>&1; then
            detected="$detected $candidate"
        else
            missing="$missing $candidate"
        fi
    done
    DETECTED_COMMANDS="${detected# }"
    MISSING_COMMANDS="${missing# }"
}

detect_commands
# `uname -m` reports the kernel, not this process. On a translating device the two disagree:
# the x86_64 emulator answers x86_64 while the arm64-only APK runs as arm64-v8a. The prompt
# tells the Agent to choose native downloads by this value, so the kernel answer sends it
# after binaries that cannot execute here. The bundled node is the arm64 build, so its
# process.arch is what will actually run; fall back only if node cannot answer.
DEVICE_ARCH="$("$NODE" -p 'process.arch' 2>/dev/null || echo "")"
if [ -z "$DEVICE_ARCH" ]; then
    DEVICE_ARCH="$(getprop ro.product.cpu.abi 2>/dev/null || echo "")"
fi
if [ -z "$DEVICE_ARCH" ]; then
    DEVICE_ARCH="$("$TOYBOX" uname -m 2>/dev/null || echo unknown)"
fi
KERNEL_ARCH="$("$TOYBOX" uname -m 2>/dev/null || echo unknown)"
DEVICE_ABILIST="$(getprop ro.product.cpu.abilist 2>/dev/null || echo unknown)"
ANDROID_RELEASE="$(getprop ro.build.version.release 2>/dev/null || echo unknown)"
ANDROID_SDK="$(getprop ro.build.version.sdk 2>/dev/null || echo unknown)"
log "Agent environment prompt: arch=$DEVICE_ARCH kernel=$KERNEL_ARCH android=$ANDROID_RELEASE sdk=$ANDROID_SDK"
log "Agent environment prompt: detected=$DETECTED_COMMANDS"

"$TOYBOX" cat > "$PASEO_BASE_SYSTEM_PROMPT_FILE" <<PASEO_AGENT_ENVIRONMENT_FACTS
You are running inside Paseo Enhanced in an Android application sandbox, not on a desktop computer.

This device, detected at startup:
- Android $ANDROID_RELEASE (API $ANDROID_SDK).
- Architecture: $DEVICE_ARCH. This is what this process actually executes as, reported by the
  bundled Node runtime. Build and download for this, not for the kernel.
- Kernel reports: $KERNEL_ARCH. Supported ABIs: $DEVICE_ABILIST. When the kernel disagrees with
  the architecture above, the device is translating and \`uname -m\` is misleading here.
- HOME=$HOME
- PREFIX=$PREFIX
- TMPDIR=${TMPDIR:-$PREFIX/tmp}
- PATH=$PATH
- Commands confirmed present: $DETECTED_COMMANDS
- Confirmed absent right now: $MISSING_COMMANDS
PASEO_AGENT_ENVIRONMENT_FACTS

"$TOYBOX" cat >> "$PASEO_BASE_SYSTEM_PROMPT_FILE" <<'PASEO_AGENT_ENVIRONMENT'

The lists above were probed on this device at startup. They are authoritative over any
assumption about what a Linux box usually has, but they can go stale within a session: if
the user installs something, re-check with `command -v <name>` rather than trusting the list.

Environment facts:
- OS/runtime: Android with a Termux-compatible userland. Do not assume Windows, macOS, desktop Linux, WSL, systemd, Docker, or a graphical desktop.
- App package: com.dshcli.
- Use the HOME, PREFIX, TMPDIR, and PATH values above. Do not hardcode com.termux paths. Private app files normally live under /data/user/0/com.dshcli/files (also reachable through Android's /data/data alias where available).
- Check the architecture above before downloading any native binary, and use the process architecture rather than `uname -m`. Never download or run Windows .exe installers.
- Android scoped storage and app permissions apply. Work only in the current workspace or paths the user selected and the app can access.
- There is no graphical display, no desktop session, and no service manager. Long-running work must be a plain background process.

Working rules:
- Install missing packages with `pkg install <package>` (apt is the same package manager). Ask first when the download is large or the package is unusual.
- Agent CLIs other than the bundled ones exist only after the user installs them from the Paseo console. Check with `command -v <name>` before invoking one.
- Use POSIX shell. Do not issue PowerShell, cmd.exe, .exe, sudo, systemctl, launchctl, brew, winget, or desktop-only instructions.
- `su` may exist without the device being rooted; do not rely on root.
- Prefer Android/Termux-compatible packages and JavaScript entry points. Confirm paths, ABI, and permissions instead of treating the phone like a PC.
PASEO_AGENT_ENVIRONMENT
"$TOYBOX" chmod 600 "$PASEO_BASE_SYSTEM_PROMPT_FILE" || fail "无法保护 Agent 环境提示词文件"

ENHANCED_FINGERPRINT="$("$TOYBOX" cat "$BUNDLED_FINGERPRINT_FILE" 2>/dev/null || true)"
if [ "${#ENHANCED_FINGERPRINT}" -ne 64 ]; then
    fail "内置 Paseo 指纹无效"
fi
INSTALLED_ENHANCED_FINGERPRINT="$("$TOYBOX" cat "$ENHANCED_MARKER" 2>/dev/null || true)"
if [ "$INSTALLED_ENHANCED_FINGERPRINT" != "$ENHANCED_FINGERPRINT" ]; then
    write_status patching "正在应用 Paseo Enhanced"
    log "Applying enhanced install.mjs"
    PASEO_STANDALONE_ANDROID=1 \
        "$NODE" "$RUNTIME_DIR/enhanced/install.mjs" || fail "Paseo Enhanced 安装失败"
    "$TOYBOX" printf '%s\n' "$ENHANCED_FINGERPRINT" > "$ENHANCED_MARKER.tmp"
    "$TOYBOX" mv "$ENHANCED_MARKER.tmp" "$ENHANCED_MARKER"
    log "Enhanced installation completed"
else
    log "Enhanced fingerprint is current"
fi

write_status starting "正在启动 Paseo"
if is_paseo_ready; then
    fail "Paseo 端口 $PORT 已被占用"
fi
[ -f "$DAEMON_WORKER" ] || fail "Paseo 服务进程文件缺失"
log "Starting daemon-worker.js on 127.0.0.1:$PORT"
    PASEO_LISTEN=127.0.0.1:$PORT \
    PASEO_BASE_SYSTEM_PROMPT_FILE="$PASEO_BASE_SYSTEM_PROMPT_FILE" \
    PASEO_WEB_UI_ENABLED=true \
    PASEO_VOICE_MODE_ENABLED=false \
    PASEO_DICTATION_ENABLED=false \
    PASEO_STANDALONE_ANDROID=1 \
    "$NODE" "$DAEMON_WORKER" --no-relay --web-ui &
DAEMON_PID=$!
log "Paseo daemon pid=$DAEMON_PID"

wait_for_paseo
log "Paseo web interface is ready"
write_status ready "Paseo 已就绪"

if [ -n "$DAEMON_PID" ]; then
    wait "$DAEMON_PID"
    daemon_exit=$?
    DAEMON_PID=""
    fail "Paseo 服务意外停止（exit $daemon_exit）"
fi
