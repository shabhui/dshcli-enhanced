package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;

import org.junit.Test;

public class EacControlStateTest {

    @Test
    public void preparingAndStartingShowProgressAndAllowCancellation() {
        for (EacControlState state : Arrays.asList(
            EacControlState.preparing("Installing the runtime"),
            EacControlState.starting("Starting EAC"))) {
            assertTrue(state.showProgress());
            assertFalse(state.canStart());
            assertFalse(state.canEnter());
            assertFalse(state.canRestart());
            assertTrue(state.canStop());
            assertNull(state.endpoint());
        }
    }

    @Test
    public void runningAllowsEntryRestartAndStopButNotStart() {
        EacControlState state = EacControlState.running(
            "EAC is running", "http://127.0.0.1:17800/");

        assertEquals(EacControlState.Phase.RUNNING, state.phase());
        assertEquals("EAC is running", state.message());
        assertEquals("http://127.0.0.1:17800/", state.endpoint());
        assertFalse(state.showProgress());
        assertFalse(state.canStart());
        assertTrue(state.canEnter());
        assertTrue(state.canRestart());
        assertTrue(state.canStop());
    }

    @Test
    public void stoppedAndErrorCanStartWithoutPretendingTheyAreRunning() {
        for (EacControlState state : Arrays.asList(
            EacControlState.stopped("Stopped"),
            EacControlState.error("Failed"))) {
            assertFalse(state.showProgress());
            assertTrue(state.canStart());
            assertFalse(state.canEnter());
            assertFalse(state.canRestart());
            assertFalse(state.canStop());
            assertNull(state.endpoint());
        }
    }

    @Test
    public void normalizesBlankMessagesAndEndpoints() {
        EacControlState state = EacControlState.running("  ", "  ");

        assertEquals("EAC status is unavailable", state.message());
        assertNull(state.endpoint());
    }
}
