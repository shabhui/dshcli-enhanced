package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.File;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Rule;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.rules.TemporaryFolder;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Drives the client with canned protocol lines instead of a real sidecar. Robolectric is only
 * here because the parser uses {@code org.json}, which is an android.jar stub under plain JUnit.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class EacSidecarClientTest {

    @Rule
    public final TemporaryFolder temporary = new TemporaryFolder();

    private static final String READY_RESULT =
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"webUrl\":\"http://127.0.0.1:17800\",\"port\":17800}}";
    private static final String READY_NOTIFICATION =
        "{\"jsonrpc\":\"2.0\",\"method\":\"boot.web-ready\"," +
            "\"params\":{\"webUrl\":\"http://127.0.0.1:17800\",\"port\":17800}}";

    private final List<String> ready = new ArrayList<>();
    private final List<String> failed = new ArrayList<>();
    private final List<String> logs = new ArrayList<>();
    private final List<String> serverDeaths = new ArrayList<>();

    private final EacSidecarClient client = new EacSidecarClient(new EacSidecarClient.Listener() {
        @Override
        public void onWebReady(String webUrl, int port) {
            ready.add(webUrl + "|" + port);
        }

        @Override
        public void onFailed(String error) {
            failed.add(error);
        }

        @Override
        public void onServerDied(String error, String logPath) {
            serverDeaths.add(error + "|" + logPath);
        }
    }, logs::add);

    @Test
    public void exportsTheEacResourceRootToTheSidecarProcess() throws Exception {
        File filesDirectory = temporary.newFolder("files");
        assertTrue(PaseoHome.directory(filesDirectory).mkdirs());
        File runtimeDirectory = temporary.newFolder("runtime");
        File sidecarDirectory = new File(EacRuntimeLayout.root(runtimeDirectory), "sidecar");
        assertTrue(sidecarDirectory.mkdirs());
        File sidecarEntry = new File(sidecarDirectory, "server.java");
        Files.write(sidecarEntry.toPath(), (
            "class SidecarEnvironmentProbe {\n" +
                "  public static void main(String[] args) {\n" +
                "    System.out.println(System.getenv(\"DSH_RESOURCE_ROOT\"));\n" +
                "  }\n" +
                "}\n").getBytes(StandardCharsets.UTF_8));

        AtomicReference<String> childOutput = new AtomicReference<>();
        CountDownLatch outputSeen = new CountDownLatch(1);
        EacSidecarClient processClient = new EacSidecarClient(
            new EacSidecarClient.Listener() {
                @Override
                public void onWebReady(String webUrl, int port) {}

                @Override
                public void onFailed(String error) {}
            }, message -> {
                String prefix = "non-protocol stdout: ";
                if (!message.startsWith(prefix)) return;
                childOutput.compareAndSet(null, message.substring(prefix.length()));
                outputSeen.countDown();
            });
        File java = new File(new File(System.getProperty("java.home"), "bin"),
            System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java");

        try {
            processClient.start(
                filesDirectory, java.getAbsolutePath(), sidecarEntry.getAbsolutePath());

            assertTrue("the sidecar environment probe did not produce output",
                outputSeen.await(10, TimeUnit.SECONDS));
            assertEquals(EacRuntimeLayout.root(runtimeDirectory).getAbsolutePath(),
                childOutput.get());
        } finally {
            processClient.stop();
        }
    }

    @Test
    public void reportsWebReadyFromTheBootStartResult() {
        int id = client.beginBootStart();

        client.handleLine(READY_RESULT.replace("\"id\":1", "\"id\":" + id));

        assertEquals(1, ready.size());
        assertEquals("http://127.0.0.1:17800|17800", ready.get(0));
        assertTrue(failed.isEmpty());
    }

    @Test
    public void reportsWebReadyFromTheNotificationAlone() {
        // The notification can land before the result; a boot driven by the recovery path emits
        // only the notification. Either one on its own has to be enough.
        client.beginBootStart();

        client.handleLine(READY_NOTIFICATION);

        assertEquals(1, ready.size());
        assertEquals("http://127.0.0.1:17800|17800", ready.get(0));
    }

    @Test
    public void reportsWebReadyOnlyOnceWhenBothArrive() {
        int id = client.beginBootStart();

        client.handleLine(READY_NOTIFICATION);
        client.handleLine(READY_RESULT.replace("\"id\":1", "\"id\":" + id));

        assertEquals(1, ready.size());
    }

    @Test
    public void reportsTheErrorTextFromABootFailedNotification() {
        client.beginBootStart();

        client.handleLine("{\"jsonrpc\":\"2.0\",\"method\":\"boot.failed\"," +
            "\"params\":{\"error\":\"pnpm install exited with 1\"}}");

        assertEquals(1, failed.size());
        assertEquals("pnpm install exited with 1", failed.get(0));
        assertTrue(ready.isEmpty());
    }

    @Test
    public void reportsTheErrorTextFromAnErrorResponse() {
        // boot.start rethrows after notifying, so a real failure arrives twice: the boot.failed
        // notification and a -32000 response. Same idempotency rule as the success path.
        int id = client.beginBootStart();

        client.handleLine("{\"jsonrpc\":\"2.0\",\"method\":\"boot.failed\",\"params\":{\"error\":\"boom\"}}");
        client.handleLine("{\"jsonrpc\":\"2.0\",\"id\":" + id +
            ",\"error\":{\"code\":-32000,\"message\":\"boom\"}}");

        assertEquals(1, failed.size());
        assertEquals("boom", failed.get(0));
    }

    @Test
    public void keepsTheFirstOutcomeWhenAContradictoryOneFollows() {
        int id = client.beginBootStart();

        client.handleLine(READY_RESULT.replace("\"id\":1", "\"id\":" + id));
        client.handleLine("{\"jsonrpc\":\"2.0\",\"method\":\"boot.failed\",\"params\":{\"error\":\"late\"}}");

        assertEquals(1, ready.size());
        assertTrue("a late failure must not overwrite a delivered success", failed.isEmpty());
    }

    @Test
    public void survivesGarbageAndKeepsReadingLaterLines() throws Exception {
        // A stray console.log in a plugin puts a non-JSON line on stdout. Historically that kills
        // the read loop and the app hangs on the splash forever, so it must be skipped, not fatal.
        client.beginBootStart();
        BufferedReader reader = new BufferedReader(new StringReader(
            "starting up, not json\n" +
                "\n" +
                READY_NOTIFICATION + "\n"));

        client.pumpLines(reader);

        assertEquals(1, ready.size());
        assertEquals("http://127.0.0.1:17800|17800", ready.get(0));
        assertTrue("the unparsable line should be logged, not swallowed silently",
            logs.stream().anyMatch(line -> line.contains("starting up, not json")));
    }

    @Test
    public void publicClientForwardsHumanLogsToTheListener() {
        List<String> listenerLogs = new ArrayList<>();
        EacSidecarClient loggingClient = new EacSidecarClient(new EacSidecarClient.Listener() {
            @Override
            public void onWebReady(String webUrl, int port) {}

            @Override
            public void onFailed(String error) {}

            @Override
            public void onLog(String message) {
                listenerLogs.add(message);
            }
        });

        loggingClient.handleLine("plain child output");

        assertTrue(listenerLogs.stream().anyMatch(line -> line.contains("plain child output")));
    }

    @Test
    public void doesNotMatchAnIdLessMessageToAPendingRequest() {
        int id = client.beginBootStart();
        assertEquals(1, client.pendingRequestCount());

        // Result-shaped but no id: a notification frame, so it must not settle request `id`.
        client.handleLine("{\"jsonrpc\":\"2.0\",\"result\":{\"webUrl\":\"http://127.0.0.1:1\",\"port\":1}}");

        assertTrue(ready.isEmpty());
        assertEquals("the request must still be pending", 1, client.pendingRequestCount());
        assertEquals(1, id);
    }

    @Test
    public void ignoresResponsesForUnknownIds() {
        client.beginBootStart();

        client.handleLine(READY_RESULT.replace("\"id\":1", "\"id\":9999"));

        assertTrue(ready.isEmpty());
        assertEquals(1, client.pendingRequestCount());
    }

    @Test
    public void framesTheBootStartRequestAsOneNewlineTerminatedLine() throws Exception {
        StringBuilder sink = new StringBuilder();
        EacSidecarClient framing = new EacSidecarClient(
            new EacSidecarClient.Listener() {
                @Override
                public void onWebReady(String webUrl, int port) {}

                @Override
                public void onFailed(String error) {}
            }, logs::add);
        framing.bindWriterForTest(sink);

        int id = framing.beginBootStart();

        String line = sink.toString();
        assertTrue("must be newline terminated: readline never yields a partial line",
            line.endsWith("\n"));
        assertEquals("exactly one line", 1, line.split("\n", -1).length - 1);
        JSONObject sent = new JSONObject(line.trim());
        assertEquals("2.0", sent.getString("jsonrpc"));
        assertEquals("boot.start", sent.getString("method"));
        assertEquals(id, sent.getInt("id"));
    }

    @Test
    public void framesShutdownWithoutAnId() {
        StringBuilder sink = new StringBuilder();
        EacSidecarClient framing = new EacSidecarClient(
            new EacSidecarClient.Listener() {
                @Override
                public void onWebReady(String webUrl, int port) {}

                @Override
                public void onFailed(String error) {}
            }, logs::add);
        framing.bindWriterForTest(sink);

        framing.requestShutdown();

        assertTrue(sink.toString().contains("\"method\":\"shutdown\""));
        assertFalse("shutdown is fire and forget; no reply is awaited",
            sink.toString().contains("\"id\""));
    }

    @Test
    public void treatsAServerDeathBeforeReadyAsAFailure() {
        client.beginBootStart();

        client.handleLine("{\"jsonrpc\":\"2.0\",\"method\":\"boot.server-died\"," +
            "\"params\":{\"code\":1,\"signal\":null}}");

        assertEquals(1, failed.size());
        assertTrue(failed.get(0).contains("1"));
    }

    @Test
    public void ignoresAServerDeathAfterReadyWasDelivered() {
        // Once the WebView holds the URL, a later server-died belongs to the reload path, not to
        // startup. Reporting it as a boot failure would replace a working page with an error.
        client.beginBootStart();
        client.handleLine(READY_NOTIFICATION);

        client.handleLine("{\"jsonrpc\":\"2.0\",\"method\":\"boot.server-died\",\"params\":{\"code\":1}}");

        assertEquals(1, ready.size());
        assertTrue(failed.isEmpty());
    }

    @Test
    public void reportsAServerDeathAfterReadyWithItsLogPath() {
        client.beginBootStart();
        client.handleLine(READY_NOTIFICATION);

        client.handleLine("{\"jsonrpc\":\"2.0\",\"method\":\"boot.server-died\"," +
            "\"params\":{\"code\":17,\"logPath\":\"/tmp/dsh-web.log\"}}");

        assertEquals(1, ready.size());
        assertTrue(failed.isEmpty());
        assertEquals(1, serverDeaths.size());
        assertEquals("the web service exited (code 17)|/tmp/dsh-web.log", serverDeaths.get(0));
    }
}
