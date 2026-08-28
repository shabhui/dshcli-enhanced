#!/system/bin/sh
set -eu

APP_DIR="$HOME/.paseo-app"
MARKER="$APP_DIR/runtime-version"
RUNTIME_DIR="$APP_DIR/runtime"
PACKAGES_DIR="$RUNTIME_DIR/packages"
RUNTIME_VERSION="paseo-0.3.1-codex-0.147.0-arm64-v8"
TOYBOX="/system/bin/toybox"
STAGING_ROOT="$APP_DIR/runtime-prefix.staging"
STAGED_PREFIX="$STAGING_ROOT/prefix"
BACKUP_PREFIX="$APP_DIR/runtime-prefix.backup"
RUNTIME_OWNERSHIP="$APP_DIR/runtime-owned-paths"
NEW_OWNERSHIP="$STAGING_ROOT/runtime-owned-paths"
ALL_OWNERSHIP="$STAGING_ROOT/runtime-owned-paths.all"
PROCESSED_PATHS="$APP_DIR/runtime-prefix.processed"
COMMIT_FILE="$APP_DIR/runtime-prefix.commit"
LEGACY_PROCESSED_PATHS="$BACKUP_PREFIX/.processed-paths"
LEGACY_COMMIT_FILE="$BACKUP_PREFIX/.commit-complete"
SWAP_COMPLETE=false
MACHINE="$("$TOYBOX" uname -m 2>/dev/null || true)"
CODEX_STRICT=false
case "$MACHINE" in
    aarch64|arm64) CODEX_STRICT=true ;;
esac

path_exists() {
    [ -e "$1" ] || [ -L "$1" ]
}

safe_owned_path() {
    case "$1" in
        ""|/*|.|./*|*/.|*/./*|..|../*|*/..|*/../*|*//*|*/) return 1 ;;
        *) return 0 ;;
    esac
}

safe_target_path() {
    relative="$1"
    safe_owned_path "$relative" || return 1
    [ -L "$PREFIX" ] && return 1
    ancestor="$PREFIX"
    remaining="$relative"
    while [ "${remaining#*/}" != "$remaining" ]; do
        component="${remaining%%/*}"
        ancestor="$ancestor/$component"
        [ -L "$ancestor" ] && return 1
        remaining="${remaining#*/}"
    done
    return 0
}

rollback_runtime_swap() (
    set +e
    if [ -f "$COMMIT_FILE" ]; then
        cleanup_failed=false
        "$TOYBOX" rm -f "$MARKER.tmp" "$RUNTIME_OWNERSHIP.tmp" || cleanup_failed=true
        "$TOYBOX" rm -rf "$STAGING_ROOT" "$BACKUP_PREFIX" || cleanup_failed=true
        if [ "$cleanup_failed" = "true" ]; then
            echo "Unable to finish committed runtime cleanup; recovery state was preserved" >&2
            exit 1
        fi
        "$TOYBOX" rm -f "$PROCESSED_PATHS" || exit 1
        "$TOYBOX" rm -f "$COMMIT_FILE" || exit 1
        exit 0
    fi
    if [ "$SWAP_COMPLETE" != "true" ] && [ -f "$PROCESSED_PATHS" ]; then
        rollback_failed=false
        while read -r previous_state relative; do
            if ! safe_target_path "$relative"; then
                echo "Invalid runtime ownership path during rollback: $relative" >&2
                rollback_failed=true
                continue
            fi
            target="$PREFIX/$relative"
            saved="$BACKUP_PREFIX/$relative"
            case "$previous_state" in
                old)
                    if path_exists "$saved"; then
                        if path_exists "$target" && ! "$TOYBOX" rm -rf "$target"; then
                            rollback_failed=true
                            continue
                        fi
                        if ! "$TOYBOX" mkdir -p "${target%/*}" || ! "$TOYBOX" mv "$saved" "$target"; then
                            rollback_failed=true
                        fi
                    elif ! path_exists "$target"; then
                        rollback_failed=true
                    fi
                    ;;
                new)
                    if path_exists "$target" && ! "$TOYBOX" rm -rf "$target"; then
                        rollback_failed=true
                    fi
                    ;;
                *) rollback_failed=true ;;
            esac
        done < "$PROCESSED_PATHS"
        if [ "$rollback_failed" = "true" ]; then
            echo "Runtime rollback failed; backup and journal were preserved" >&2
            exit 1
        fi
        if [ -f "$BACKUP_PREFIX/.old-ownership" ]; then
            "$TOYBOX" cp "$BACKUP_PREFIX/.old-ownership" "$RUNTIME_OWNERSHIP" || exit 1
        elif [ -f "$BACKUP_PREFIX/.ownership-was-missing" ]; then
            "$TOYBOX" rm -f "$RUNTIME_OWNERSHIP" || exit 1
        fi
        if [ -f "$BACKUP_PREFIX/.old-marker" ]; then
            "$TOYBOX" cp "$BACKUP_PREFIX/.old-marker" "$MARKER" || exit 1
        elif [ -f "$BACKUP_PREFIX/.marker-was-missing" ]; then
            "$TOYBOX" rm -f "$MARKER" || exit 1
        fi
    fi
    cleanup_failed=false
    "$TOYBOX" rm -f "$MARKER.tmp" "$RUNTIME_OWNERSHIP.tmp" || cleanup_failed=true
    "$TOYBOX" rm -rf "$STAGING_ROOT" "$BACKUP_PREFIX" || cleanup_failed=true
    if [ "$cleanup_failed" = "true" ]; then
        echo "Runtime rollback cleanup failed; journal was preserved" >&2
        exit 1
    fi
    "$TOYBOX" rm -f "$PROCESSED_PATHS" || exit 1
    exit 0
)

rollback_on_signal() {
    signal_status="$1"
    trap - EXIT INT TERM
    rollback_runtime_swap || signal_status=$?
    exit "$signal_status"
}

# Recover a swap interrupted by an Android process kill before checking the marker.
if [ ! -f "$PROCESSED_PATHS" ] && [ -f "$LEGACY_PROCESSED_PATHS" ]; then
    "$TOYBOX" cp "$LEGACY_PROCESSED_PATHS" "$PROCESSED_PATHS" || exit 1
fi
if [ ! -f "$COMMIT_FILE" ] && [ -f "$LEGACY_COMMIT_FILE" ]; then
    : > "$COMMIT_FILE" || exit 1
fi
if [ -f "$COMMIT_FILE" ] || [ -f "$PROCESSED_PATHS" ]; then
    rollback_runtime_swap || { recovery_status=$?; exit "$recovery_status"; }
fi

if [ "$("$TOYBOX" cat "$MARKER" 2>/dev/null || true)" = "$RUNTIME_VERSION" ] && \
    [ -f "$RUNTIME_OWNERSHIP" ] && \
    [ -x "$PREFIX/bin/node" ] && \
    [ -f "$PREFIX/lib/node_modules/@getpaseo/cli/package.json" ] && \
    [ -x "$PREFIX/bin/paseo" ] && \
    { [ "$CODEX_STRICT" != "true" ] || [ -x "$PREFIX/bin/codex" ]; }; then
    exit 0
fi

while read -r expected relative; do
    [ -z "$expected" ] && continue
    relative="$("$TOYBOX" printf '%s' "$relative" | "$TOYBOX" tr -d '\r')" || exit 1
    payload="$PACKAGES_DIR/$relative"
    [ -f "$payload" ] || { echo "Missing bundled runtime payload: $relative" >&2; exit 1; }
    hash_output="$("$TOYBOX" sha256sum "$payload")" || { echo "Unable to hash bundled runtime payload: $relative" >&2; exit 1; }
    actual="${hash_output%% *}"
    [ "$actual" = "$expected" ] || { echo "Invalid bundled runtime payload: $relative" >&2; exit 1; }
done < "$PACKAGES_DIR/manifest.txt"

"$TOYBOX" rm -rf "$STAGING_ROOT" "$BACKUP_PREFIX" || exit 1
"$TOYBOX" mkdir -p "$STAGED_PREFIX" "$BACKUP_PREFIX" || exit 1
trap 'rollback_runtime_swap' EXIT
trap 'rollback_on_signal 130' INT
trap 'rollback_on_signal 143' TERM

"$TOYBOX" gzip -dc "$PACKAGES_DIR/termux-node-runtime-arm64.tgz" |
    "$TOYBOX" tar -xf - -C "$STAGED_PREFIX"
"$TOYBOX" mkdir -p "$STAGED_PREFIX/lib/node_modules"
"$TOYBOX" gzip -dc "$PACKAGES_DIR/paseo-node-modules-arm64.tgz" |
    "$TOYBOX" tar -xf - -C "$STAGED_PREFIX/lib"
"$TOYBOX" chmod 755 "$STAGED_PREFIX/bin/node"
"$TOYBOX" chmod 755 "$STAGED_PREFIX/lib/node_modules/@getpaseo/cli/bin/paseo"
STAGED_CODEX_VENDOR="$STAGED_PREFIX/lib/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl"
"$TOYBOX" chmod 755 "$STAGED_PREFIX/lib/node_modules/@openai/codex/bin/codex.js"
"$TOYBOX" chmod 755 "$STAGED_CODEX_VENDOR/bin/codex"
"$TOYBOX" chmod 755 "$STAGED_CODEX_VENDOR/bin/codex-code-mode-host"
"$TOYBOX" chmod 755 "$STAGED_CODEX_VENDOR/codex-path/rg"
"$TOYBOX" chmod 755 "$STAGED_CODEX_VENDOR/codex-resources/bwrap"
"$TOYBOX" chmod 755 "$STAGED_CODEX_VENDOR/codex-resources/zsh/bin/zsh"

: > "$NEW_OWNERSHIP"
append_owned_path() {
    entry="$1"
    path_exists "$entry" || return 0
    relative="${entry#"$STAGED_PREFIX/"}"
    safe_owned_path "$relative" || { echo "Invalid staged runtime path: $relative" >&2; exit 1; }
    "$TOYBOX" printf '%s\n' "$relative" >> "$NEW_OWNERSHIP" || exit 1
}
append_directory_units() {
    directory="$1"
    for entry in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
        append_owned_path "$entry"
    done
}

append_directory_units "$STAGED_PREFIX/bin"
append_directory_units "$STAGED_PREFIX/etc"
append_directory_units "$STAGED_PREFIX/share"
for entry in "$STAGED_PREFIX/lib"/* "$STAGED_PREFIX/lib"/.[!.]* "$STAGED_PREFIX/lib"/..?*; do
    path_exists "$entry" || continue
    [ "${entry##*/}" = "node_modules" ] && continue
    append_owned_path "$entry"
done
for entry in "$STAGED_PREFIX/lib/node_modules"/* "$STAGED_PREFIX/lib/node_modules"/.[!.]* "$STAGED_PREFIX/lib/node_modules"/..?*; do
    path_exists "$entry" || continue
    name="${entry##*/}"
    case "$name" in
        @*)
            for package in "$entry"/* "$entry"/.[!.]* "$entry"/..?*; do append_owned_path "$package"; done
            ;;
        *) append_owned_path "$entry" ;;
    esac
done
"$TOYBOX" printf '%s\n' 'bin/paseo' 'bin/codex' >> "$NEW_OWNERSHIP" || exit 1
"$TOYBOX" sort -u "$NEW_OWNERSHIP" -o "$NEW_OWNERSHIP" || exit 1
if [ -f "$RUNTIME_OWNERSHIP" ]; then
    "$TOYBOX" cp "$RUNTIME_OWNERSHIP" "$BACKUP_PREFIX/.old-ownership" || exit 1
    "$TOYBOX" cat "$RUNTIME_OWNERSHIP" > "$ALL_OWNERSHIP.input" || exit 1
    "$TOYBOX" cat "$NEW_OWNERSHIP" >> "$ALL_OWNERSHIP.input" || exit 1
    "$TOYBOX" sort -u "$ALL_OWNERSHIP.input" -o "$ALL_OWNERSHIP" || exit 1
    "$TOYBOX" rm -f "$ALL_OWNERSHIP.input" || exit 1
else
    : > "$BACKUP_PREFIX/.ownership-was-missing" || exit 1
    "$TOYBOX" cp "$NEW_OWNERSHIP" "$ALL_OWNERSHIP" || exit 1
fi
: > "$PROCESSED_PATHS" || exit 1
if [ -f "$MARKER" ]; then
    "$TOYBOX" cp "$MARKER" "$BACKUP_PREFIX/.old-marker" || exit 1
else
    : > "$BACKUP_PREFIX/.marker-was-missing" || exit 1
fi
"$TOYBOX" rm -f "$MARKER" || exit 1
"$TOYBOX" mkdir -p "$PREFIX" || exit 1
while IFS= read -r relative; do
    safe_target_path "$relative" || { echo "Invalid runtime ownership path: $relative" >&2; exit 1; }
    target="$PREFIX/$relative"
    staged="$STAGED_PREFIX/$relative"
    saved="$BACKUP_PREFIX/$relative"
    if path_exists "$target"; then
        "$TOYBOX" printf 'old %s\n' "$relative" >> "$PROCESSED_PATHS" || exit 1
        "$TOYBOX" mkdir -p "${saved%/*}" || exit 1
        "$TOYBOX" mv "$target" "$saved" || exit 1
    else
        "$TOYBOX" printf 'new %s\n' "$relative" >> "$PROCESSED_PATHS" || exit 1
    fi
    if path_exists "$staged"; then
        "$TOYBOX" mkdir -p "${target%/*}" || exit 1
        "$TOYBOX" mv "$staged" "$target" || exit 1
    fi
done < "$ALL_OWNERSHIP"

"$TOYBOX" rm -f "$PREFIX/bin/paseo" || exit 1
"$TOYBOX" printf '%s\n' \
    '#!/system/bin/sh' \
    'PREFIX="${PREFIX:-/data/data/com.paseoe/files/usr}"' \
    'exec "$PREFIX/bin/node" --disable-warning=DEP0040 "$PREFIX/lib/node_modules/@getpaseo/cli/bin/paseo" "$@"' \
    > "$PREFIX/bin/paseo" || exit 1
"$TOYBOX" chmod 755 "$PREFIX/bin/paseo" || exit 1
"$TOYBOX" rm -f "$PREFIX/bin/codex" || exit 1
"$TOYBOX" printf '%s\n' \
    '#!/system/bin/sh' \
    'PREFIX="${PREFIX:-/data/data/com.paseoe/files/usr}"' \
    'exec "$PREFIX/bin/node" "$PREFIX/lib/node_modules/@openai/codex/bin/codex.js" "$@"' \
    > "$PREFIX/bin/codex" || exit 1
"$TOYBOX" chmod 755 "$PREFIX/bin/codex" || exit 1

if ! NODE_VERSION="$("$PREFIX/bin/node" --version)"; then
    echo "Bundled Node.js is unavailable" >&2
    exit 1
fi
[ "$NODE_VERSION" = "v24.18.0" ] || { echo "Unexpected bundled Node.js version: $NODE_VERSION" >&2; exit 1; }
if ! PASEO_VERSION="$("$PREFIX/bin/node" -p "require('$PREFIX/lib/node_modules/@getpaseo/cli/package.json').version")"; then
    echo "Bundled Paseo CLI is unavailable" >&2
    exit 1
fi
[ "$PASEO_VERSION" = "0.3.1" ] || { echo "Unexpected bundled Paseo CLI version: $PASEO_VERSION" >&2; exit 1; }
if [ "$CODEX_STRICT" = "true" ]; then
    if ! CODEX_VERSION="$("$PREFIX/bin/codex" --version)"; then
        echo "Bundled Codex CLI is unavailable" >&2
        exit 1
    fi
    [ "$CODEX_VERSION" = "codex-cli 0.147.0" ] || { echo "Unexpected bundled Codex CLI version: $CODEX_VERSION" >&2; exit 1; }
else
    echo "Bundled Codex CLI is ARM64-only on $MACHINE; continuing Paseo startup" >&2
fi

"$TOYBOX" cp "$NEW_OWNERSHIP" "$RUNTIME_OWNERSHIP.tmp" || exit 1
"$TOYBOX" mv "$RUNTIME_OWNERSHIP.tmp" "$RUNTIME_OWNERSHIP" || exit 1
"$TOYBOX" printf '%s\n' "$RUNTIME_VERSION" > "$MARKER.tmp" || exit 1
"$TOYBOX" mv "$MARKER.tmp" "$MARKER" || exit 1
: > "$COMMIT_FILE" || exit 1
SWAP_COMPLETE=true
"$TOYBOX" rm -rf "$STAGING_ROOT" "$BACKUP_PREFIX" || exit 1
"$TOYBOX" rm -f "$PROCESSED_PATHS" || exit 1
"$TOYBOX" rm -f "$COMMIT_FILE" || exit 1
trap - EXIT INT TERM
