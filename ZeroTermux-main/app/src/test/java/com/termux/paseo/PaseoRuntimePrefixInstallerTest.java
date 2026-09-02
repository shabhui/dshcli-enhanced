package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class PaseoRuntimePrefixInstallerTest {

    @Rule
    public final TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void installsTheBundledPrefixBeforeABackendIsLaunched() throws Exception {
        File filesDirectory = folder.newFolder("files");
        File homeDirectory = new File(filesDirectory, "home");
        assertTrue(homeDirectory.mkdirs());
        File runtimeDirectory = folder.newFolder("runtime");
        File installer = new File(runtimeDirectory, "install-bundled-runtime.sh");
        assertTrue(installer.createNewFile());
        CapturingStarter starter = new CapturingStarter(new FakeProcess(0, "installed\n"));

        PaseoRuntimePrefixInstaller.install(filesDirectory, runtimeDirectory, starter);

        ProcessBuilder builder = starter.builder;
        assertEquals("/system/bin/sh", builder.command().get(0));
        assertEquals(installer.getAbsolutePath(), builder.command().get(1));
        assertEquals(homeDirectory, builder.directory());
        assertEquals(new File(filesDirectory, "usr").getAbsolutePath(),
            builder.environment().get("PREFIX"));
        assertEquals(new File(filesDirectory, "usr/bin").getAbsolutePath() +
            ":/system/bin:/system/xbin", builder.environment().get("PATH"));
        assertTrue("stdout and stderr share one drained pipe", builder.redirectErrorStream());
    }

    @Test
    public void reportsInstallerOutputWhenThePrefixInstallFails() throws Exception {
        File filesDirectory = folder.newFolder("failed-files");
        assertTrue(new File(filesDirectory, "home").mkdirs());
        File runtimeDirectory = folder.newFolder("failed-runtime");
        assertTrue(new File(runtimeDirectory, "install-bundled-runtime.sh").createNewFile());

        try {
            PaseoRuntimePrefixInstaller.install(filesDirectory, runtimeDirectory,
                new CapturingStarter(new FakeProcess(17, "hash mismatch\n")));
            fail("a non-zero installer exit must fail runtime preparation");
        } catch (IOException error) {
            assertTrue(error.getMessage().contains("17"));
            assertTrue(error.getMessage().contains("hash mismatch"));
        }
    }

    @Test
    public void refusesToSpawnWhenTheBundledInstallerIsMissing() throws Exception {
        File filesDirectory = folder.newFolder("missing-files");
        File runtimeDirectory = folder.newFolder("missing-runtime");
        CapturingStarter starter = new CapturingStarter(new FakeProcess(0, ""));

        try {
            PaseoRuntimePrefixInstaller.install(filesDirectory, runtimeDirectory, starter);
            fail("a missing installer must fail before process creation");
        } catch (IOException error) {
            assertTrue(error.getMessage().contains("install-bundled-runtime.sh"));
            assertNull(starter.builder);
        }
    }

    private static final class CapturingStarter
        implements PaseoRuntimePrefixInstaller.ProcessStarter {
        private final Process process;
        private ProcessBuilder builder;

        private CapturingStarter(Process process) {
            this.process = process;
        }

        @Override
        public Process start(ProcessBuilder builder) {
            this.builder = builder;
            return process;
        }
    }

    private static final class FakeProcess extends Process {
        private final int exitCode;
        private final InputStream output;

        private FakeProcess(int exitCode, String output) {
            this.exitCode = exitCode;
            this.output = new ByteArrayInputStream(output.getBytes(StandardCharsets.UTF_8));
        }

        @Override
        public OutputStream getOutputStream() {
            return new ByteArrayOutputStream();
        }

        @Override
        public InputStream getInputStream() {
            return output;
        }

        @Override
        public InputStream getErrorStream() {
            return new ByteArrayInputStream(new byte[0]);
        }

        @Override
        public int waitFor() {
            return exitCode;
        }

        @Override
        public int exitValue() {
            return exitCode;
        }

        @Override
        public void destroy() {}
    }
}
