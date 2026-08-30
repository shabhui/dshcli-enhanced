package com.termux.paseo;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Newline-delimited JSON-RPC client for the EAC sidecar ({@code tauri-shell/sidecar/server.ts}).
 *
 * <p>Deliberately separate from {@link PaseoRuntimeController}, which spawns a shell script and
 * polls {@code $HOME/.paseo-app/status-<runId>}. That status file is known to report {@code ready}
 * before the service actually serves; the sidecar's RPC contract hands back the exact
 * {@code {webUrl, port}} instead.
 *
 * <p>Parsing is kept free of process and threading concerns so it can be driven line by line from a
 * plain JVM test.
 */
public final class EacSidecarClient {
    public interface Listener {
        void onWebReady(String webUrl, int port);

        void onFailed(String error);
    }

    /** Diagnostic sink. Defaults to {@code Log.i}; injected in tests so output is assertable. */
    interface LogSink {
        void log(String message);
    }

    /** One protocol line, already newline terminated, written and flushed as a unit. */
    private interface LineWriter {
        void write(String line) throws IOException;
    }

    private static final String TAG = "EacSidecar";
    private static final long SHUTDOWN_GRACE_MS = 3000L;
    private static final long SHUTDOWN_POLL_MS = 50L;

    private final Listener listener;
    private final LogSink logSink;
    /** id → method name of requests awaiting a response. */
    private final Map<Integer, String> pending = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);
    /** Latches on the first outcome so exactly one listener callback ever fires. */
    private final AtomicBoolean settled = new AtomicBoolean(false);
    private final Object writeLock = new Object();

    private volatile LineWriter lineWriter;
    private volatile Process process;

    public EacSidecarClient(Listener listener) {
        this(listener, message -> Log.i(TAG, message));
    }

    EacSidecarClient(Listener listener, LogSink logSink) {
        this.listener = listener;
        this.logSink = logSink;
    }

    /**
     * Spawns the sidecar and issues {@code boot.start}.
     *
     * <p>No {@code --expose-internals} here: that flag belongs to the {@code dsh web} child the
     * sidecar spawns itself (see {@code boot-server.ts}), not to the sidecar process.
     */
    public void start(File filesDirectory, String nodePath, String sidecarEntry) throws IOException {
        ProcessBuilder builder = new ProcessBuilder(nodePath, sidecarEntry);
        File home = PaseoHome.directory(filesDirectory);
        builder.directory(home);
        PaseoProcessEnvironment.apply(builder.environment(), filesDirectory);
        // Never redirectErrorStream: stderr carries `[sidecar] ...` human logs, and merging them
        // into stdout corrupts the protocol stream.
        Process started = builder.start();
        process = started;

        Writer stdin = new OutputStreamWriter(started.getOutputStream(), StandardCharsets.UTF_8);
        lineWriter = line -> {
            stdin.write(line);
            stdin.flush();
        };

        pump("eac-sidecar-stdout", started.getInputStream(), true);
        // stderr must be drained even though it is not protocol: a full pipe blocks the sidecar.
        pump("eac-sidecar-stderr", started.getErrorStream(), false);

        beginBootStart();
    }

    private void pump(String name, java.io.InputStream stream, boolean protocol) {
        Thread thread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                if (protocol) {
                    pumpLines(reader);
                } else {
                    String line;
                    while ((line = reader.readLine()) != null) logSink.log(line);
                }
            } catch (IOException closed) {
                logSink.log(name + " closed: " + closed.getMessage());
            }
            if (protocol) fail("sidecar exited before the web service was ready");
        }, name);
        thread.setDaemon(true);
        thread.start();
    }

    /** Reads to EOF. A single malformed frame must not take the reader down with it. */
    void pumpLines(BufferedReader reader) throws IOException {
        String line;
        while ((line = reader.readLine()) != null) {
            try {
                handleLine(line);
            } catch (RuntimeException error) {
                logSink.log("dropped a frame: " + error);
            }
        }
    }

    void handleLine(String rawLine) {
        String line = rawLine == null ? "" : rawLine.trim();
        if (line.isEmpty()) return;

        JSONObject message;
        try {
            message = new JSONObject(line);
        } catch (JSONException notProtocol) {
            // Anything a plugin prints on stdout lands here. Log and keep reading; treating it as
            // fatal would strand the splash screen on an otherwise healthy boot.
            logSink.log("non-protocol stdout: " + line);
            return;
        }

        String method = message.optString("method", "");
        if (!method.isEmpty()) {
            handleNotification(method, message.optJSONObject("params"));
            return;
        }
        // No `method`, so this is a response — but only if it carries a real id. The parse-error
        // frame uses id:null, and a bare result frame has no id at all; neither settles a request.
        if (message.isNull("id")) {
            logSink.log("frame without method or id, ignored: " + line);
            return;
        }
        handleResponse(message.optInt("id", -1), message);
    }

    private void handleResponse(int id, JSONObject message) {
        String method = pending.remove(id);
        if (method == null) {
            logSink.log("response for an unknown id " + id + ", ignored");
            return;
        }
        JSONObject error = message.optJSONObject("error");
        if (error != null) {
            fail(error.optString("message", "sidecar reported an error"));
            return;
        }
        if ("boot.start".equals(method)) {
            deliverReady(message.optJSONObject("result"));
        }
    }

    private void handleNotification(String method, JSONObject params) {
        switch (method) {
            case "boot.web-ready":
                deliverReady(params);
                return;
            case "boot.failed":
                fail(params == null ? "" : params.optString("error", ""));
                return;
            case "boot.server-died":
                // After the WebView holds a URL this belongs to the restart path, not to startup.
                // Reporting it as a boot failure would swap a working page for an error screen.
                if (!settled.get()) {
                    fail("the web service exited (code " +
                        (params == null ? "?" : params.optString("code", "?")) + ")");
                }
                return;
            default:
                logSink.log("notification " + method);
        }
    }

    private void deliverReady(JSONObject payload) {
        if (payload == null) return;
        String webUrl = payload.optString("webUrl", "");
        int port = payload.optInt("port", 0);
        if (webUrl.isEmpty() || port <= 0) {
            logSink.log("ready payload missing webUrl/port, ignored");
            return;
        }
        // boot.start's result and boot.web-ready carry the same information and both arrive; order
        // is not guaranteed, so first one wins and the second is a no-op rather than an error.
        if (settled.compareAndSet(false, true)) listener.onWebReady(webUrl, port);
    }

    private void fail(String error) {
        if (!settled.compareAndSet(false, true)) return;
        listener.onFailed(error == null || error.isEmpty() ? "the web service failed to start" : error);
    }

    int beginBootStart() {
        return request("boot.start");
    }

    private int request(String method) {
        int id = nextId.getAndIncrement();
        pending.put(id, method);
        JSONObject message = new JSONObject();
        try {
            message.put("jsonrpc", "2.0");
            message.put("id", id);
            message.put("method", method);
            message.put("params", new JSONObject());
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
        send(message);
        return id;
    }

    /** Fire and forget per the contract: the sidecar answers {@code {bye:true}} then closes stdin. */
    void requestShutdown() {
        JSONObject message = new JSONObject();
        try {
            message.put("jsonrpc", "2.0");
            message.put("method", "shutdown");
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
        send(message);
    }

    private void send(JSONObject message) {
        LineWriter writer = lineWriter;
        if (writer == null) return;
        synchronized (writeLock) {
            try {
                writer.write(message + "\n");
            } catch (IOException gone) {
                logSink.log("could not write to the sidecar: " + gone.getMessage());
            }
        }
    }

    /**
     * Distinguishes "still installing" from "actually dead". First boot runs pnpm and takes far
     * longer than on desktop, so a caller must poll this rather than fail on a fixed timeout.
     */
    public boolean isProcessAlive() {
        Process current = process;
        return current != null && !PaseoRuntimeController.processHasExited(current);
    }

    public boolean isReady() {
        return settled.get();
    }

    /** Asks for a clean shutdown, waits a bounded while, then kills. */
    public void stop() {
        Process current = process;
        process = null;
        if (current == null) return;
        requestShutdown();
        long deadline = System.currentTimeMillis() + SHUTDOWN_GRACE_MS;
        while (System.currentTimeMillis() < deadline) {
            if (PaseoRuntimeController.processHasExited(current)) return;
            try {
                Thread.sleep(SHUTDOWN_POLL_MS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        current.destroy();
    }

    int pendingRequestCount() {
        return pending.size();
    }

    void bindWriterForTest(StringBuilder sink) {
        lineWriter = sink::append;
    }
}
