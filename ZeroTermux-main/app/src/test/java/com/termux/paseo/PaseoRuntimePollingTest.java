package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.os.Looper;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = Application.class, manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
public class PaseoRuntimePollingTest {
    @Test
    public void finishedReadWaitsForMainThreadAndCannotDispatchIntoARetry() throws Exception {
        PaseoRuntimeController controller = new PaseoRuntimeController();
        List<PaseoRuntimeState> received = new ArrayList<>();
        set(controller, "listener", (PaseoRuntimeController.Listener) received::add);
        Runnable poll = (Runnable) field("statusPoll").get(controller);
        ExecutorService worker = (ExecutorService) field("RUNTIME_INSTALL_EXECUTOR").get(null);
        try {
            poll.run();
            worker.submit(() -> {}).get(5, TimeUnit.SECONDS);
            assertTrue("worker must never dispatch to the listener", received.isEmpty());
            controller.stop();
            set(controller, "finished", false);
            set(controller, "listener", (PaseoRuntimeController.Listener) received::add);
            shadowOf(Looper.getMainLooper()).idle();
            assertTrue("completed read from the old generation must be dropped", received.isEmpty());
            poll.run();
            worker.submit(() -> {}).get(5, TimeUnit.SECONDS);
            shadowOf(Looper.getMainLooper()).idle();
            assertEquals(1, received.size());
        } finally {
            controller.stop();
            shadowOf(Looper.getMainLooper()).idle();
        }
    }

    private static Field field(String name) throws Exception {
        Field field = PaseoRuntimeController.class.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    private static void set(PaseoRuntimeController controller, String name, Object value) throws Exception {
        field(name).set(controller, value);
    }
}
