#!/system/bin/sh
set -eu

APP_DIR="$HOME/.paseo-app"
MARKER="$APP_DIR/runtime-version"
RUNTIME_DIR="$APP_DIR/runtime"
PACKAGES_DIR="$RUNTIME_DIR/packages"
RUNTIME_VERSION="paseo-0.3.1-codex-0.147.0-npm-11.16.0-pnpm-11.7.0-eac-5.3.1-arm64-v10"
TOYBOX="/system/bin/toybox"
EAC_ARCHIVE="$PACKAGES_DIR/eac-runtime-arm64.tgz"
EAC_ROOT="$RUNTIME_DIR/eac"
EAC_STAGING_ROOT="$RUNTIME_DIR/eac-payload.staging"
EAC_STAGED_ROOT="$EAC_STAGING_ROOT/eac"
EAC_BACKUP="$RUNTIME_DIR/eac.backup"
EAC_SHA_FILE="$EAC_ROOT/.payload-sha256"
EAC_SWAP_ACTIVE=false
EAC_HAD_LIVE=false
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

validate_eac_root() {
    root="$1"
    [ -f "$root/sidecar/server.js" ] &&
        [ -f "$root/sidecar/bridge.js" ] &&
        [ -f "$root/sidecar/phone-bridge.js" ] &&
        [ -f "$root/sidecar/rescue-integration.js" ] &&
        [ -f "$root/dsh-desktop/package.json" ] &&
        [ -f "$root/dsh-desktop/lib/desktop/boot-server.js" ]
}

rollback_eac_swap() (
    set +e
    if [ "$EAC_SWAP_ACTIVE" = "true" ]; then
        "$TOYBOX" rm -rf "$EAC_ROOT"
        if [ "$EAC_HAD_LIVE" = "true" ] && path_exists "$EAC_BACKUP"; then
            "$TOYBOX" mv "$EAC_BACKUP" "$EAC_ROOT" || exit 1
        fi
    fi
    "$TOYBOX" rm -rf "$EAC_STAGING_ROOT" || exit 1
)

rollback_eac_on_signal() {
    signal_status="$1"
    trap - EXIT INT TERM
    rollback_eac_swap || signal_status=$?
    exit "$signal_status"
}

recover_eac_swap() {
    expected_sha="$1"
    "$TOYBOX" rm -rf "$EAC_STAGING_ROOT" || exit 1
    path_exists "$EAC_BACKUP" || return 0
    current_sha="$("$TOYBOX" cat "$EAC_SHA_FILE" 2>/dev/null || true)"
    if validate_eac_root "$EAC_ROOT" && [ "$current_sha" = "$expected_sha" ]; then
        "$TOYBOX" rm -rf "$EAC_BACKUP" || exit 1
        return 0
    fi
    "$TOYBOX" rm -rf "$EAC_ROOT" || exit 1
    "$TOYBOX" mv "$EAC_BACKUP" "$EAC_ROOT" || exit 1
}

install_eac_payload() {
    expected_sha="$1"
    recover_eac_swap "$expected_sha"
    current_sha="$("$TOYBOX" cat "$EAC_SHA_FILE" 2>/dev/null || true)"
    if [ "$current_sha" = "$expected_sha" ] && validate_eac_root "$EAC_ROOT"; then
        return 0
    fi

    [ -f "$EAC_ARCHIVE" ] || { echo "Missing bundled EAC payload" >&2; exit 1; }
    hash_output="$("$TOYBOX" sha256sum "$EAC_ARCHIVE")" || {
        echo "Unable to hash bundled EAC payload" >&2
        exit 1
    }
    actual_sha="${hash_output%% *}"
    [ "$actual_sha" = "$expected_sha" ] || { echo "Invalid bundled EAC payload" >&2; exit 1; }

    "$TOYBOX" rm -rf "$EAC_STAGING_ROOT" || exit 1
    "$TOYBOX" mkdir -p "$EAC_STAGING_ROOT" || exit 1
    "$TOYBOX" gzip -dc "$EAC_ARCHIVE" |
        "$TOYBOX" tar -xf - -C "$EAC_STAGING_ROOT"
    validate_eac_root "$EAC_STAGED_ROOT" || { echo "Incomplete staged EAC payload" >&2; exit 1; }
    "$TOYBOX" printf '%s\n' "$expected_sha" > "$EAC_STAGED_ROOT/.payload-sha256.tmp" || exit 1
    "$TOYBOX" mv "$EAC_STAGED_ROOT/.payload-sha256.tmp" "$EAC_STAGED_ROOT/.payload-sha256" || exit 1

    EAC_HAD_LIVE=false
    if path_exists "$EAC_ROOT"; then
        "$TOYBOX" rm -rf "$EAC_BACKUP" || exit 1
        "$TOYBOX" mv "$EAC_ROOT" "$EAC_BACKUP" || exit 1
        EAC_HAD_LIVE=true
    fi
    EAC_SWAP_ACTIVE=true
    trap 'rollback_eac_swap' EXIT
    trap 'rollback_eac_on_signal 130' INT
    trap 'rollback_eac_on_signal 143' TERM
    "$TOYBOX" mv "$EAC_STAGED_ROOT" "$EAC_ROOT" || exit 1
    validate_eac_root "$EAC_ROOT" || { echo "Incomplete installed EAC payload" >&2; exit 1; }
    [ "$("$TOYBOX" cat "$EAC_SHA_FILE" 2>/dev/null || true)" = "$expected_sha" ] || exit 1
    "$TOYBOX" rm -rf "$EAC_BACKUP" "$EAC_STAGING_ROOT" || exit 1
    EAC_SWAP_ACTIVE=false
    EAC_HAD_LIVE=false
    trap - EXIT INT TERM
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

MANIFEST="$PACKAGES_DIR/manifest.txt"
[ -f "$MANIFEST" ] || { echo "Bundled runtime manifest is missing" >&2; exit 1; }
EAC_EXPECTED_SHA=""
while read -r expected relative; do
    [ -z "$expected" ] && continue
    relative="$("$TOYBOX" printf '%s' "$relative" | "$TOYBOX" tr -d '\r')" || exit 1
    if [ "$relative" = "eac-runtime-arm64.tgz" ]; then
        EAC_EXPECTED_SHA="$expected"
    fi
done < "$MANIFEST"
case "$EAC_EXPECTED_SHA" in
    ""|*[!0-9a-f]*) echo "Invalid EAC checksum in bundled runtime manifest" >&2; exit 1 ;;
esac
[ "${#EAC_EXPECTED_SHA}" -eq 64 ] || { echo "Invalid EAC checksum length" >&2; exit 1; }
install_eac_payload "$EAC_EXPECTED_SHA"

if [ "$("$TOYBOX" cat "$MARKER" 2>/dev/null || true)" = "$RUNTIME_VERSION" ] && \
    [ -f "$RUNTIME_OWNERSHIP" ] && \
    [ -x "$PREFIX/bin/node" ] && \
    [ -f "$PREFIX/lib/node_modules/@getpaseo/cli/package.json" ] && \
    [ -x "$PREFIX/bin/paseo" ] && \
    [ -x "$PREFIX/bin/npm" ] && \
    [ -x "$PREFIX/bin/pnpm" ] && \
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
done < "$MANIFEST"

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
"$TOYBOX" printf '%s\n' 'bin/paseo' 'bin/codex' 'bin/npm' 'bin/pnpm' >> "$NEW_OWNERSHIP" || exit 1
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
    'PREFIX="${PREFIX:-/data/data/com.dshcli/files/usr}"' \
    'exec "$PREFIX/bin/node" --disable-warning=DEP0040 "$PREFIX/lib/node_modules/@getpaseo/cli/bin/paseo" "$@"' \
    > "$PREFIX/bin/paseo" || exit 1
"$TOYBOX" chmod 755 "$PREFIX/bin/paseo" || exit 1
"$TOYBOX" rm -f "$PREFIX/bin/codex" || exit 1
"$TOYBOX" printf '%s\n' \
    '#!/system/bin/sh' \
    'PREFIX="${PREFIX:-/data/data/com.dshcli/files/usr}"' \
    'exec "$PREFIX/bin/node" "$PREFIX/lib/node_modules/@openai/codex/bin/codex.js" "$@"' \
    > "$PREFIX/bin/codex" || exit 1
"$TOYBOX" chmod 755 "$PREFIX/bin/codex" || exit 1
# npm / pnpm wrappers: the kernel installs plugins by shelling out to them over
# PATH ($PREFIX/bin:/system/bin:/system/xbin). Both are pure JS, so they run on
# the bundled node; a shebang lookup is not an option because Termux has no
# /usr/bin/env. Entry-point names differ per tool (npm-cli.js vs pnpm.cjs) and
# are asserted in the payload at assembly time.
"$TOYBOX" rm -f "$PREFIX/bin/npm" || exit 1
"$TOYBOX" printf '%s\n' \
    '#!/system/bin/sh' \
    'PREFIX="${PREFIX:-/data/data/com.dshcli/files/usr}"' \
    'exec "$PREFIX/bin/node" "$PREFIX/lib/node_modules/npm/bin/npm-cli.js" "$@"' \
    > "$PREFIX/bin/npm" || exit 1
"$TOYBOX" chmod 755 "$PREFIX/bin/npm" || exit 1
"$TOYBOX" rm -f "$PREFIX/bin/pnpm" || exit 1
"$TOYBOX" printf '%s\n' \
    '#!/system/bin/sh' \
    'PREFIX="${PREFIX:-/data/data/com.dshcli/files/usr}"' \
    'exec "$PREFIX/bin/node" "$PREFIX/lib/node_modules/pnpm/bin/pnpm.cjs" "$@"' \
    > "$PREFIX/bin/pnpm" || exit 1
"$TOYBOX" chmod 755 "$PREFIX/bin/pnpm" || exit 1

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
