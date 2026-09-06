package com.termux.paseo;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Test;

public class PaseoRuntimeControllerTest {

    @Test
    public void controllerLaunchesTheAppOwnedRuntimeWithoutATerminalService() throws Exception {
        String source = new String(Files.readAllBytes(new File(
            "src/main/java/com/termux/paseo/PaseoRuntimeController.java").toPath()),
            StandardCharsets.UTF_8);

        assertTrue(source.contains("new ProcessBuilder"));
        assertTrue(source.contains("PaseoProcessEnvironment.apply"));
        assertFalse(source.contains("TermuxService"));
        assertFalse(source.contains("bindService"));
        assertFalse(source.contains("createTermuxTask"));
    }

    @Test
    public void controllerBootstrapsTheTermuxShellBeforeOverlayingPaseoRuntime() throws Exception {
        String source = new String(Files.readAllBytes(new File(
            "src/main/java/com/termux/paseo/PaseoRuntimeController.java").toPath()),
            StandardCharsets.UTF_8);

        assertTrue(source.contains("TermuxInstaller.setupBootstrapIfNeeded"));
        assertTrue(source.contains("prepareOverlayRuntime"));
    }

    @Test
    public void controllerContinuesHealthPollingAfterReady() throws Exception {
        String source = new String(Files.readAllBytes(new File(
            "src/main/java/com/termux/paseo/PaseoRuntimeController.java").toPath()),
            StandardCharsets.UTF_8);

        assertTrue(source.contains("processHasExited(process)"));
        assertFalse(source.contains("startupProcess.isAlive()"));
        assertFalse(source.contains("state.phase() != PaseoRuntimeState.Phase.READY &&"));
        // Health polling must keep running after READY, but the status file reads happen off
        // the main thread: the poll only schedules work onto the runtime executor.
        assertTrue(source.contains("RUNTIME_INSTALL_EXECUTOR.execute("));
        assertTrue(source.contains("handler.postDelayed(statusPoll, STATUS_POLL_MS)"));
    }

    @Test
    public void statusPollReadsStateOffTheMainThreadAndDropsStaleGenerations() throws Exception {
        String source = new String(Files.readAllBytes(new File(
            "src/main/java/com/termux/paseo/PaseoRuntimeController.java").toPath()),
            StandardCharsets.UTF_8);

        // The background read must capture the generation snapshot and drop work from a
        // stopped/restarted run instead of dispatching stale state.
        int pollStart = source.indexOf("private final Runnable statusPoll");
        int pollEnd = source.indexOf("};", pollStart);
        String pollBody = source.substring(pollStart, pollEnd);
        assertTrue(pollBody.contains("final long generation = runGeneration;"));
        assertTrue(pollBody.contains("if (finished || generation != runGeneration) return;"));
    }

    @Test
    public void runtimeErrorsInvalidateBothFastPathMarkersBeforeRetry() throws Exception {
        String source = new String(Files.readAllBytes(new File(
            "src/main/java/com/termux/paseo/PaseoRuntimeController.java").toPath()),
            StandardCharsets.UTF_8);

        assertTrue(source.contains("invalidateRuntimeMarkers"));
        assertTrue(source.contains("asset-fingerprint"));
        assertTrue(source.contains("runtime-version"));
        assertTrue(source.contains("state.phase() == PaseoRuntimeState.Phase.ERROR"));
    }

    @Test
    public void processLivenessCheckWorksOnAndroidApi24() {
        assertFalse(PaseoRuntimeController.processHasExited(new FakeProcess(false)));
        assertTrue(PaseoRuntimeController.processHasExited(new FakeProcess(true)));
    }

    @Test
    public void paseoPortConfigAcceptsUnprivilegedPortsExceptTheInternalCodexProxy() {
        assertEquals(6767, PaseoPortConfig.normalize(6767));
        assertEquals(8080, PaseoPortConfig.normalize(8080));
        assertEquals(PaseoPortConfig.DEFAULT_PORT, PaseoPortConfig.normalize(6768));
        assertEquals(PaseoPortConfig.DEFAULT_PORT, PaseoPortConfig.normalize(1023));
        assertEquals(PaseoPortConfig.DEFAULT_PORT, PaseoPortConfig.normalize(65536));
    }

    @Test
    public void paseoPortConfigParsesPersistedTextWithoutAcceptingReservedPorts() {
        assertEquals(8080, PaseoPortConfig.parse("8080"));
        assertEquals(PaseoPortConfig.DEFAULT_PORT, PaseoPortConfig.parse(" 6768 "));
        assertEquals(PaseoPortConfig.DEFAULT_PORT, PaseoPortConfig.parse("not-a-port"));
        assertEquals("http://127.0.0.1:8080/", PaseoPortConfig.homeUrl(8080));
    }

    @Test
    public void controllerPassesTheSelectedPortToStartupAndPreservesItForRetry() throws Exception {
        String source = new String(Files.readAllBytes(new File(
            "src/main/java/com/termux/paseo/PaseoRuntimeController.java").toPath()),
            StandardCharsets.UTF_8);

        assertTrue(source.contains("start(Activity activity, Listener listener, int port)"));
        assertTrue(source.contains("selectedPort = PaseoPortConfig.normalize(port)"));
        assertTrue(source.contains("String.valueOf(selectedPort)"));
        assertTrue(source.contains("start(currentActivity, currentListener, currentPort)"));
    }

    @Test
    public void anInstalledLauncherTakesOverInsteadOfSpawningTheDaemon() throws Exception {
        String source = new String(Files.readAllBytes(new File(
            "src/main/java/com/termux/paseo/PaseoRuntimeController.java").toPath()),
            StandardCharsets.UTF_8);

        // The branch point sits after the runtime assets are installed and before paseo's own
        // daemon is spawned, so the EAC path reuses bootstrap + asset install and replaces only
        // the launch step.
        assertTrue(source.contains("RuntimeLauncher"));
        assertTrue(source.contains("interface RuntimeLauncher"));
        assertTrue(source.contains("launcher.launch(runtimeDirectory)"));
        // Null or a launcher that declines must fall through to the unchanged paseo path.
        assertTrue(source.contains("launcher == null || !launcher.launch(runtimeDirectory)"));
        assertTrue(source.contains("startPaseoTask(generation, runtimeDirectory)"));
    }

    @Test
    public void runtimePrefixIsInstalledBeforeTheLauncherAndStaleSuccessIsIgnored() throws Exception {
        String source = new String(Files.readAllBytes(new File(
            "src/main/java/com/termux/paseo/PaseoRuntimeController.java").toPath()),
            StandardCharsets.UTF_8);
        int preparation = source.indexOf("runtimePreparer.prepare(");
        int workerStart = source.indexOf("() -> {", preparation);
        int callbackStart = source.indexOf("() -> {", workerStart + 1);
        int failure = source.indexOf("error ->", callbackStart);
        String worker = source.substring(workerStart, callbackStart);
        String callback = source.substring(callbackStart, failure);

        assertTrue(worker.contains("PaseoRuntimePrefixInstaller.install("));
        assertTrue(callback.contains("if (!isCurrentRun(generation)) return;"));
        assertTrue(callback.indexOf("isCurrentRun(generation)") <
            callback.indexOf("launcher.launch(runtimeDirectory)"));
    }

    @Test
    public void theLauncherDecisionIsIndependentOfActivityState() {
        // A pure decision so it is exercisable without an Activity: EAC present means take over.
        File runtime = new File("/nonexistent/runtime");
        assertFalse(EacRuntimeLayout.isInstalled(runtime));
    }

    @Test
    public void startupScriptAcceptsAndUsesTheSelectedPort() throws Exception {
        String script = new String(Files.readAllBytes(new File(
            "src/main/assets/paseo-runtime/start-paseo.sh").toPath()), StandardCharsets.UTF_8);

        assertTrue(script.contains("PORT=\"${2:-6767}\""));
        assertTrue(script.contains("127.0.0.1:$PORT"));
        assertTrue(script.contains("PASEO_LISTEN=127.0.0.1:$PORT"));
        // The startup surface is localised; the selected port still has to reach the diagnostic.
        assertTrue(script.contains("fail \"Paseo 端口 $PORT 已被占用\""));
    }

    private static final class FakeProcess extends Process {
        private boolean exited;

        private FakeProcess(boolean exited) {
            this.exited = exited;
        }

        @Override
        public OutputStream getOutputStream() {
            return new ByteArrayOutputStream();
        }

        @Override
        public InputStream getInputStream() {
            return new ByteArrayInputStream(new byte[0]);
        }

        @Override
        public InputStream getErrorStream() {
            return new ByteArrayInputStream(new byte[0]);
        }

        @Override
        public int waitFor() {
            return 0;
        }

        @Override
        public int exitValue() {
            if (!exited) throw new IllegalThreadStateException("still running");
            return 0;
        }

        @Override
        public void destroy() {
            exited = true;
        }
    }
}
