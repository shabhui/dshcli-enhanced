package com.termux.paseo;

import android.app.Activity;
import android.content.res.AssetManager;
import android.os.Handler;
import android.os.Looper;

import com.termux.R;
import com.termux.app.TermuxInstaller;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class PaseoRuntimeController {
    public interface Listener {
        void onState(PaseoRuntimeState state);
    }

    /**
     * Replaces the launch step once the runtime assets are on disk.
     *
     * <p>Bootstrap and asset install are shared by every backend; only what gets spawned afterwards
     * differs. Returning false declines and leaves paseo's own daemon path untouched.
     */
    public interface RuntimeLauncher {
        boolean launch(File runtimeDirectory);
    }

    private static final long STATUS_POLL_MS = 500L;
    private static final ExecutorService RUNTIME_INSTALL_EXECUTOR = Executors.newSingleThreadExecutor(command -> {
        Thread thread = new Thread(command, "paseo-runtime-installer");
        thread.setDaemon(true);
        return thread;
    });

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final PaseoAssetInstaller assetInstaller = new PaseoAssetInstaller();
    private final PaseoRuntimePreparer runtimePreparer = new PaseoRuntimePreparer(
        RUNTIME_INSTALL_EXECUTOR, command -> handler.post(command));
    private Activity activity;
    private Listener listener;
    private RuntimeLauncher launcher;
    private File homeDirectory;
    private Process startupProcess;
    private boolean finished;
    private boolean repairOnRetry;
    private long runGeneration;
    private String currentRunId;
    private int selectedPort = PaseoPortConfig.DEFAULT_PORT;

    // Only file I/O crosses threads; run state and listener callbacks stay on the main looper.
    private final Runnable statusPoll = new Runnable() {
        @Override
        public void run() {
            if (finished) return;
            final long generation = runGeneration;
            final Process process = startupProcess;
            final File currentHome = homeDirectory;
            final String runId = currentRunId;
            final String waiting = text(R.string.paseo_status_waiting_runtime, "Waiting for the embedded Paseo runtime");
            final String installing = text(R.string.paseo_status_installing_runtime, "Installing the embedded Paseo runtime");
            RUNTIME_INSTALL_EXECUTOR.execute(() -> {
                PaseoRuntimeState read = readState(currentHome, runId, waiting, installing);
                handler.post(() -> {
                    if (finished || generation != runGeneration) return;
                    PaseoRuntimeState state = read;
                    if (process != null && processHasExited(process) &&
                        state.phase() != PaseoRuntimeState.Phase.ERROR) {
                        state = new PaseoRuntimeState(PaseoRuntimeState.Phase.ERROR,
                            text(R.string.paseo_status_daemon_stopped, "Paseo daemon stopped unexpectedly"));
                    }
                    dispatch(state);
                    if (isCurrentRun(generation) && state.phase() != PaseoRuntimeState.Phase.ERROR) {
                        handler.postDelayed(statusPoll, STATUS_POLL_MS);
                    }
                });
            });
        }
    };

    /** Set before {@link #start}; survives {@link #stop} and {@link #retry}. */
    public void setRuntimeLauncher(RuntimeLauncher launcher) {
        this.launcher = launcher;
    }

    public void start(Activity activity, Listener listener) {
        start(activity, listener, PaseoPortConfig.DEFAULT_PORT);
    }

    public void start(Activity activity, Listener listener, int port) {
        this.activity = activity;
        this.listener = listener;
        this.selectedPort = PaseoPortConfig.normalize(port);
        this.finished = false;
        this.repairOnRetry = false;
        this.runGeneration++;
        this.currentRunId = null;
        this.homeDirectory = PaseoHome.directory(activity.getFilesDir());
        dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.INSTALLING,
            text(R.string.paseo_status_preparing_runtime, "Preparing the embedded Paseo runtime")));
        preparePaseoRuntime(runGeneration);
    }

    public void retry() {
        if (activity == null || listener == null) return;
        Activity currentActivity = activity;
        Listener currentListener = listener;
        File currentHome = homeDirectory;
        int currentPort = selectedPort;
        boolean repair = repairOnRetry;
        stop();
        if (repair && currentHome != null) invalidateRuntimeMarkers(currentHome);
        start(currentActivity, currentListener, currentPort);
    }

    public void stop() {
        finished = true;
        runGeneration++;
        currentRunId = null;
        handler.removeCallbacks(statusPoll);
        if (startupProcess != null) {
            startupProcess.destroy();
            startupProcess = null;
        }
        homeDirectory = null;
        activity = null;
        listener = null;
    }

    private void preparePaseoRuntime(long generation) {
        if (!isCurrentRun(generation) || activity == null || homeDirectory == null) return;

        dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.INSTALLING,
            text(R.string.paseo_status_preparing_terminal, "Preparing the embedded terminal")));
        TermuxInstaller.setupBootstrapIfNeeded(activity, () -> prepareOverlayRuntime(generation));
    }

    private void prepareOverlayRuntime(long generation) {
        if (!isCurrentRun(generation) || activity == null || homeDirectory == null) return;

        Activity currentActivity = activity;
        File filesDirectory = currentActivity.getFilesDir();
        File currentHome = homeDirectory;
        AssetManager assets = currentActivity.getApplicationContext().getAssets();
        File runtimeDirectory = new File(currentHome, ".paseo-app/runtime");
        dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.INSTALLING,
            text(R.string.paseo_status_installing_runtime, "Installing the embedded Paseo runtime")));
        runtimePreparer.prepare(
            () -> {
                ensureDirectory(currentHome);
                ensureDirectory(new File(filesDirectory, "usr/tmp"));
                assetInstaller.install(assets, "paseo-runtime", runtimeDirectory);
                PaseoRuntimePrefixInstaller.install(filesDirectory, runtimeDirectory);
            },
            () -> {
                if (!isCurrentRun(generation)) return;
                // Branch point: an installed launcher (EAC) takes over here, reusing everything
                // above. Declining falls through to paseo's own daemon, unchanged.
                if (launcher == null || !launcher.launch(runtimeDirectory)) {
                    startPaseoTask(generation, runtimeDirectory);
                }
            },
            error -> {
                if (isCurrentRun(generation)) {
                    dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.ERROR, messageFor(error)));
                }
            });
    }

    private void startPaseoTask(long generation, File runtimeDirectory) {
        if (!isCurrentRun(generation) || activity == null || homeDirectory == null) return;

        try {
            File script = new File(runtimeDirectory, "start-paseo.sh");
            script.setExecutable(true, true);
            String runId = UUID.randomUUID().toString();
            currentRunId = runId;
            ProcessBuilder processBuilder = new ProcessBuilder(
                "/system/bin/sh", script.getAbsolutePath(), runId,
                String.valueOf(selectedPort));
            processBuilder.directory(homeDirectory);
            Map<String, String> environment = processBuilder.environment();
            PaseoProcessEnvironment.apply(environment, activity.getFilesDir());
            environment.remove("LD_PRELOAD");
            startupProcess = processBuilder.start();
            handler.removeCallbacks(statusPoll);
            handler.post(statusPoll);
        } catch (Exception error) {
            currentRunId = null;
            dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.ERROR, messageFor(error)));
        }
    }

    private static PaseoRuntimeState readState(File currentHome, String expectedRunId,
                                               String waitingForRuntime, String installing) {
        if (expectedRunId == null) {
            return new PaseoRuntimeState(PaseoRuntimeState.Phase.INSTALLING, waitingForRuntime);
        }
        if (currentHome == null) {
            return new PaseoRuntimeState(PaseoRuntimeState.Phase.INSTALLING, waitingForRuntime);
        }
        File statusFile = new File(currentHome, ".paseo-app/status-" + expectedRunId);
        if (!statusFile.isFile()) {
            return new PaseoRuntimeState(PaseoRuntimeState.Phase.INSTALLING,
                installing);
        }
        StringBuilder contents = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
            new FileInputStream(statusFile), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (contents.length() > 0) contents.append('\n');
                contents.append(line);
            }
            return PaseoRunStatus.parse(expectedRunId, contents.toString());
        } catch (IOException error) {
            return new PaseoRuntimeState(PaseoRuntimeState.Phase.INSTALLING,
                waitingForRuntime);
        }
    }

    private String text(int resourceId, String fallback) {
        Activity current = activity;
        if (current == null) return fallback;
        try {
            return current.getString(resourceId);
        } catch (RuntimeException error) {
            return fallback;
        }
    }

    private boolean isCurrentRun(long generation) {
        return !finished && generation == runGeneration;
    }

    private void dispatch(PaseoRuntimeState state) {
        if (state.phase() == PaseoRuntimeState.Phase.ERROR) repairOnRetry = true;
        if (listener != null) listener.onState(state);
    }

    private static void invalidateRuntimeMarkers(File homeDirectory) {
        File appDirectory = new File(homeDirectory, ".paseo-app");
        new File(appDirectory, "runtime/asset-fingerprint").delete();
        new File(appDirectory, "runtime-version").delete();
        new File(appDirectory, "enhanced-fingerprint").delete();
    }

    static boolean processHasExited(Process process) {
        try {
            process.exitValue();
            return true;
        } catch (IllegalThreadStateException running) {
            return false;
        }
    }

    private static String messageFor(Exception error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? error.getClass().getSimpleName() : message;
    }

    private static void ensureDirectory(File directory) throws IOException {
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("Unable to create " + directory);
        }
        if (!directory.isDirectory()) throw new IOException("Not a directory: " + directory);
    }
}
