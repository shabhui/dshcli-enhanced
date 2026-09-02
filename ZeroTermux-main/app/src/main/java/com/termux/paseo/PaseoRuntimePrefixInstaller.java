package com.termux.paseo;

import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;

/** Installs the bundled Node/npm prefix before either runtime backend is launched. */
final class PaseoRuntimePrefixInstaller {
    interface ProcessStarter {
        Process start(ProcessBuilder builder) throws IOException;
    }

    private static final int MAX_DIAGNOSTIC_CHARS = 8192;

    private PaseoRuntimePrefixInstaller() {}

    static void install(File filesDirectory, File runtimeDirectory) throws IOException {
        install(filesDirectory, runtimeDirectory, ProcessBuilder::start);
    }

    static void install(
        File filesDirectory,
        File runtimeDirectory,
        ProcessStarter processStarter
    ) throws IOException {
        File installer = new File(runtimeDirectory, "install-bundled-runtime.sh");
        if (!installer.isFile()) {
            throw new IOException("Missing bundled runtime installer: " + installer);
        }

        ProcessBuilder builder = new ProcessBuilder(
            "/system/bin/sh", installer.getAbsolutePath());
        builder.directory(PaseoHome.directory(filesDirectory));
        PaseoProcessEnvironment.apply(builder.environment(), filesDirectory);
        builder.redirectErrorStream(true);

        Process process = processStarter.start(builder);
        String output = drainOutput(process);
        final int exitCode;
        try {
            exitCode = process.waitFor();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            process.destroy();
            throw new IOException("Bundled runtime installation was interrupted", interrupted);
        }
        if (exitCode != 0) {
            String detail = output.isEmpty() ? "" : ": " + output;
            throw new IOException(
                "Bundled runtime installer exited with " + exitCode + detail);
        }
    }

    private static String drainOutput(Process process) throws IOException {
        StringBuilder output = new StringBuilder();
        char[] buffer = new char[2048];
        try (Reader reader = new InputStreamReader(
            process.getInputStream(), StandardCharsets.UTF_8)) {
            int count;
            while ((count = reader.read(buffer)) != -1) {
                output.append(buffer, 0, count);
                if (output.length() > MAX_DIAGNOSTIC_CHARS) {
                    output.delete(0, output.length() - MAX_DIAGNOSTIC_CHARS);
                }
            }
        }
        return output.toString().trim();
    }
}
