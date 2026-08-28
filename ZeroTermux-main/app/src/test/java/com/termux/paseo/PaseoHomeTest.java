package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class PaseoHomeTest {

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void resolvesTheUnifiedTermuxHome() {
        File filesDirectory = new File("/data/user/0/com.paseoe/files");

        // "home" is what TermuxConstants.TERMUX_HOME_DIR_PATH resolves to, so a Termux
        // session and the Paseo daemon land in the same directory.
        assertEquals("home", PaseoHome.directory(filesDirectory).getName());
        assertEquals(filesDirectory, PaseoHome.directory(filesDirectory).getParentFile());
        assertEquals(".paseo-app", PaseoHome.appDirectory(filesDirectory).getName());
        assertEquals(PaseoHome.directory(filesDirectory),
            PaseoHome.appDirectory(filesDirectory).getParentFile());
    }

    @Test
    public void migrationIsANoOpWithoutALegacyHome() throws IOException {
        File filesDirectory = temporaryFolder.newFolder("files");

        assertTrue(PaseoHome.migrateLegacyHome(filesDirectory).isEmpty());
        assertFalse(new File(filesDirectory, "paseo-home").exists());
    }

    @Test
    public void movesLegacyStateIntoTheUnifiedHome() throws IOException {
        File filesDirectory = temporaryFolder.newFolder("files");
        File legacyApp = new File(filesDirectory, "paseo-home/.paseo-app");
        assertTrue(legacyApp.mkdirs());
        write(new File(legacyApp, "config.json"), "{\"port\":6777}");

        assertTrue(PaseoHome.migrateLegacyHome(filesDirectory).isEmpty());

        File migrated = new File(filesDirectory, "home/.paseo-app/config.json");
        assertTrue(migrated.isFile());
        assertEquals("{\"port\":6777}", read(migrated));
        assertFalse("the legacy home should be gone once fully migrated",
            new File(filesDirectory, "paseo-home").exists());
    }

    @Test
    public void keepsExistingUnifiedStateAndLeavesTheLegacyCopyBehind() throws IOException {
        File filesDirectory = temporaryFolder.newFolder("files");
        File legacyApp = new File(filesDirectory, "paseo-home/.paseo-app");
        assertTrue(legacyApp.mkdirs());
        write(new File(legacyApp, "config.json"), "legacy");
        File unifiedApp = new File(filesDirectory, "home/.paseo-app");
        assertTrue(unifiedApp.mkdirs());
        write(new File(unifiedApp, "config.json"), "live");

        assertFalse("a name clash must be reported as a problem",
            PaseoHome.migrateLegacyHome(filesDirectory).isEmpty());

        assertEquals("live", read(new File(unifiedApp, "config.json")));
        assertEquals("the legacy copy must survive for inspection",
            "legacy", read(new File(legacyApp, "config.json")));
    }

    @Test
    public void migratesSiblingsThatDoNotClash() throws IOException {
        File filesDirectory = temporaryFolder.newFolder("files");
        File legacy = new File(filesDirectory, "paseo-home");
        assertTrue(new File(legacy, ".paseo-app").mkdirs());
        write(new File(legacy, "notes.txt"), "keep me");
        File unified = new File(filesDirectory, "home");
        assertTrue(new File(unified, ".paseo-app").mkdirs());

        PaseoHome.migrateLegacyHome(filesDirectory);

        assertEquals("keep me", read(new File(unified, "notes.txt")));
    }

    private static void write(File file, String contents) throws IOException {
        Files.write(file.toPath(), contents.getBytes(StandardCharsets.UTF_8));
    }

    private static String read(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }
}
