package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class EacRuntimeLayoutTest {

    @Rule
    public final TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void placesTheSidecarBesideDshDesktopLikeTheShippedProduct() {
        File runtime = new File("/data/data/com.dshcli/files/home/.paseo-app/runtime");

        File entry = EacRuntimeLayout.sidecarEntry(runtime);

        assertEquals("server.js", entry.getName());
        assertEquals("sidecar", entry.getParentFile().getName());
        // The .deb installs <root>/dsh-desktop and <root>/sidecar as siblings; keep that shape so
        // the sidecar's own relative resolution of dsh-desktop keeps working unchanged.
        assertTrue(new File(entry.getParentFile().getParentFile(), "dsh-desktop")
            .getPath().replace('\\', '/').endsWith("/eac/dsh-desktop"));
    }

    @Test
    public void reportsNotInstalledUntilEveryCriticalRuntimeFileIsPresent() throws IOException {
        File runtime = folder.newFolder("runtime");

        assertFalse("an empty runtime tree must not claim EAC is installed",
            EacRuntimeLayout.isInstalled(runtime));

        File root = EacRuntimeLayout.root(runtime);
        File[] required = new File[] {
            new File(root, "sidecar/server.js"),
            new File(root, "sidecar/bridge.js"),
            new File(root, "sidecar/phone-bridge.js"),
            new File(root, "sidecar/rescue-integration.js"),
            new File(root, "dsh-desktop/package.json"),
            new File(root, "dsh-desktop/lib/desktop/boot-server.js"),
        };
        for (int index = 0; index < required.length; index++) {
            File file = required[index];
            assertTrue(file.getParentFile().isDirectory() || file.getParentFile().mkdirs());
            assertTrue(file.createNewFile());
            if (index < required.length - 1) {
                assertFalse("a partial EAC payload must not pass the installed gate",
                    EacRuntimeLayout.isInstalled(runtime));
            }
        }
        assertTrue(EacRuntimeLayout.isInstalled(runtime));
    }

    @Test
    public void treatsADirectoryNamedServerJsAsNotInstalled() throws IOException {
        File runtime = folder.newFolder("runtime2");
        File entry = EacRuntimeLayout.sidecarEntry(runtime);
        assertTrue(entry.mkdirs());

        assertFalse(EacRuntimeLayout.isInstalled(runtime));
    }

    @Test
    public void reportsNotInstalledForANullRuntimeDirectory() {
        assertFalse(EacRuntimeLayout.isInstalled(null));
    }
}
