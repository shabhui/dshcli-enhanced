package com.termux.paseo;

import java.io.File;

/**
 * Where the EAC payload sits inside paseo's runtime tree.
 *
 * <p>Mirrors the shipped .deb, which installs {@code <root>/dsh-desktop} and {@code <root>/sidecar}
 * as siblings. Keeping that shape means the sidecar resolves dsh-desktop relative to itself exactly
 * as it does on desktop, so no path patching is needed.
 *
 * <p>{@link #isInstalled} is the gate for the EAC launch path: the payload is not in the runtime
 * tarball yet, and without the gate an APK built today would spawn a missing file and strand the
 * splash screen instead of falling back to paseo's own daemon.
 */
final class EacRuntimeLayout {
    private EacRuntimeLayout() {}

    private static final String ROOT = "eac";
    private static final String[] REQUIRED_FILES = {
        "sidecar/server.js",
        "sidecar/bridge.js",
        "sidecar/phone-bridge.js",
        "sidecar/rescue-integration.js",
        "dsh-desktop/package.json",
        "dsh-desktop/lib/desktop/boot-server.js",
    };

    static File root(File runtimeDirectory) {
        return new File(runtimeDirectory, ROOT);
    }

    static File sidecarEntry(File runtimeDirectory) {
        return new File(root(runtimeDirectory), "sidecar/server.js");
    }

    static File dshDesktop(File runtimeDirectory) {
        return new File(root(runtimeDirectory), "dsh-desktop");
    }

    static boolean isInstalled(File runtimeDirectory) {
        if (runtimeDirectory == null) return false;
        File root = root(runtimeDirectory);
        for (String relativePath : REQUIRED_FILES) {
            if (!new File(root, relativePath).isFile()) return false;
        }
        return true;
    }
}
