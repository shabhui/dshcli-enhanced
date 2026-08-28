package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeNoException;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class PaseoAssetInstallerTest {
    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void installsByVersionAndAtomicallyReplacesAnOlderTree() throws Exception {
        File destination = new File(temporaryFolder.getRoot(), "runtime");
        PaseoAssetInstaller installer = new PaseoAssetInstaller();

        FakeAssetSource versionOne = new FakeAssetSource()
            .file("runtime/runtime-version", "1")
            .file("runtime/packages/manifest.txt", "")
            .file("runtime/payload.txt", "old")
            .file("runtime/stale.txt", "remove me");
        installer.install(versionOne, "runtime", destination);

        FakeAssetSource versionTwo = new FakeAssetSource()
            .file("runtime/runtime-version", "2")
            .file("runtime/packages/manifest.txt", "")
            .file("runtime/payload.txt", "new");
        installer.install(versionTwo, "runtime", destination);

        assertEquals("2", read(new File(destination, "runtime-version")));
        assertEquals("new", read(new File(destination, "payload.txt")));
        assertFalse(new File(destination, "stale.txt").exists());

        versionTwo.file("runtime/payload.txt", "should not be recopied");
        installer.install(versionTwo, "runtime", destination);
        assertEquals("new", read(new File(destination, "payload.txt")));
    }

    @Test
    public void failedUpgradeLeavesTheInstalledTreeUntouched() throws Exception {
        File destination = new File(temporaryFolder.getRoot(), "runtime");
        PaseoAssetInstaller installer = new PaseoAssetInstaller();
        installer.install(new FakeAssetSource()
            .file("runtime/runtime-version", "1")
            .file("runtime/packages/manifest.txt", "")
            .file("runtime/payload.txt", "working"), "runtime", destination);

        FakeAssetSource brokenUpgrade = new FakeAssetSource()
            .file("runtime/runtime-version", "2")
            .file("runtime/packages/manifest.txt", "")
            .file("runtime/payload.txt", "broken")
            .failOnOpen("runtime/payload.txt");

        assertThrows(IOException.class, () -> installer.install(brokenUpgrade, "runtime", destination));
        assertEquals("1", read(new File(destination, "runtime-version")));
        assertEquals("working", read(new File(destination, "payload.txt")));
    }

    @Test
    public void sameVersionWithCorruptedRuntimePayloadIsReinstalled() throws Exception {
        File destination = new File(temporaryFolder.getRoot(), "runtime");
        PaseoAssetInstaller installer = new PaseoAssetInstaller();
        String payload = "healthy runtime";
        String manifest = sha256(payload) + "  runtime.tgz";
        FakeAssetSource source = new FakeAssetSource()
            .file("runtime/runtime-version", "1")
            .file("runtime/packages/manifest.txt", manifest)
            .file("runtime/packages/runtime.tgz", payload);

        installer.install(source, "runtime", destination);
        Files.write(new File(destination, "packages/runtime.tgz").toPath(),
            "corrupted".getBytes(StandardCharsets.UTF_8));

        installer.install(source, "runtime", destination);

        assertEquals(payload, read(new File(destination, "packages/runtime.tgz")));
    }

    @Test
    public void sameRuntimeVersionRefreshesChangedEnhancedSources() throws Exception {
        File destination = new File(temporaryFolder.getRoot(), "runtime");
        PaseoAssetInstaller installer = new PaseoAssetInstaller();
        FakeAssetSource source = new FakeAssetSource()
            .file("runtime/runtime-version", "1")
            .file("runtime/asset-fingerprint", "fingerprint-one")
            .file("runtime/packages/manifest.txt", "")
            .file("runtime/enhanced/install.mjs", "first");

        installer.install(source, "runtime", destination);
        source.file("runtime/enhanced/install.mjs", "updated");
        source.file("runtime/asset-fingerprint", "fingerprint-two");
        installer.install(source, "runtime", destination);

        assertEquals("updated", read(new File(destination, "enhanced/install.mjs")));
    }

    @Test
    public void matchingAssetFingerprintSkipsOpeningLargeRuntimePayloads() throws Exception {
        File destination = new File(temporaryFolder.getRoot(), "runtime");
        PaseoAssetInstaller installer = new PaseoAssetInstaller();
        String payload = "large runtime payload";
        String manifest = sha256(payload) + "  runtime.tgz";
        FakeAssetSource source = new FakeAssetSource()
            .file("runtime/runtime-version", "1")
            .file("runtime/asset-fingerprint", "bundle-fingerprint")
            .file("runtime/packages/manifest.txt", manifest)
            .file("runtime/packages/runtime.tgz", payload)
            .file("runtime/enhanced/install.mjs", "enhanced");

        installer.install(source, "runtime", destination);
        source.failOnOpen("runtime/packages/runtime.tgz");

        installer.install(source, "runtime", destination);
        assertEquals("bundle-fingerprint", read(new File(destination, "asset-fingerprint")));
    }

    @Test
    public void recursiveCleanupDoesNotFollowDirectorySymlinks() throws Exception {
        File parent = temporaryFolder.newFolder("symlink-parent");
        File outside = temporaryFolder.newFolder("outside-runtime");
        File sentinel = new File(outside, "keep.txt");
        Files.write(sentinel.toPath(), "keep".getBytes(StandardCharsets.UTF_8));
        Path link = new File(parent, "staging-link").toPath();
        try {
            Files.createSymbolicLink(link, outside.toPath());
        } catch (IOException | UnsupportedOperationException error) {
            assumeNoException("symbolic links are unavailable in this test environment", error);
            return;
        }

        Method cleanup = PaseoAssetInstaller.class.getDeclaredMethod("deleteRecursively", File.class);
        cleanup.setAccessible(true);
        try {
            cleanup.invoke(null, link.toFile());
        } catch (InvocationTargetException error) {
            throw (Exception) error.getCause();
        }

        assertTrue("outside runtime data must survive cleanup", sentinel.isFile());
        assertTrue("the link itself should be removed", Files.notExists(link));
    }

    @Test
    public void assetInstallerUsesAndroidApi24CompatibleFileOperations() throws Exception {
        File sourceFile = new File("src/main/java/com/termux/paseo/PaseoAssetInstaller.java");
        String source = new String(
            Files.readAllBytes(sourceFile.toPath()), StandardCharsets.UTF_8);

        assertFalse("main installer must not load java.nio.file on Android API 24",
            source.contains("java.nio.file"));
        assertFalse("main installer must use File operations for cleanup", source.contains("Files."));
    }

    private static String read(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).trim();
    }

    private static String sha256(String contents) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256")
            .digest(contents.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte value : digest) hex.append(String.format("%02x", value & 0xff));
        return hex.toString();
    }

    private static final class FakeAssetSource implements PaseoAssetInstaller.AssetSource {
        private final Map<String, byte[]> files = new LinkedHashMap<>();
        private final Set<String> failures = new LinkedHashSet<>();

        FakeAssetSource file(String path, String contents) {
            files.put(path, contents.getBytes(StandardCharsets.UTF_8));
            return this;
        }

        FakeAssetSource failOnOpen(String path) {
            failures.add(path);
            return this;
        }

        @Override
        public String[] list(String path) {
            String prefix = path.endsWith("/") ? path : path + "/";
            Set<String> children = new LinkedHashSet<>();
            for (String file : files.keySet()) {
                if (!file.startsWith(prefix)) continue;
                String remainder = file.substring(prefix.length());
                int slash = remainder.indexOf('/');
                children.add(slash < 0 ? remainder : remainder.substring(0, slash));
            }
            List<String> result = new ArrayList<>(children);
            return result.toArray(new String[0]);
        }

        @Override
        public InputStream open(String path) throws IOException {
            if (failures.contains(path)) throw new IOException("simulated copy failure");
            byte[] contents = files.get(path);
            if (contents == null) throw new IOException("missing asset " + path);
            return new ByteArrayInputStream(contents);
        }
    }
}
