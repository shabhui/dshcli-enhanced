package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** Plain JUnit: {@link EacWebTarget} is pure {@code java.net.URI}, no android.jar stubs involved. */
public class EacWebTargetTest {

    @Test
    public void keepsTheOneTimeTokenForTheFirstLoadAndDropsItForHome() {
        // The kernel's ready line carries a single-use token; loading it a second time 401s after
        // the 303 cookie exchange has consumed it.
        EacWebTarget target = EacWebTarget.parse("http://127.0.0.1:17800/?token=abc123");

        assertNotNull(target);
        assertEquals("http://127.0.0.1:17800/?token=abc123", target.initialUrl());
        assertEquals("http://127.0.0.1:17800/", target.homeUrl());
        assertEquals(17800, target.port());
    }

    @Test
    public void acceptsABareOriginWhenTheReadyLineHadNoToken() {
        // boot-server falls back to the bare origin when the ready line never arrives.
        EacWebTarget target = EacWebTarget.parse("http://127.0.0.1:17800");

        assertNotNull(target);
        assertEquals("http://127.0.0.1:17800", target.initialUrl());
        assertEquals("http://127.0.0.1:17800/", target.homeUrl());
        assertEquals(17800, target.port());
    }

    @Test
    public void keepsAnExplicitPathInTheHomeUrl() {
        EacWebTarget target = EacWebTarget.parse("http://127.0.0.1:17800/app/?token=x");

        assertNotNull(target);
        assertEquals("http://127.0.0.1:17800/app/", target.homeUrl());
    }

    @Test
    public void rejectsUrlsWithoutAUsablePort() {
        assertNull(EacWebTarget.parse("http://127.0.0.1/"));
        assertNull(EacWebTarget.parse(""));
        assertNull(EacWebTarget.parse(null));
        assertNull(EacWebTarget.parse("not a url at all"));
    }

    @Test
    public void rejectsAnythingOutsideTheExactLocalHttpOrigin() {
        assertNull(EacWebTarget.parse("https://127.0.0.1:17800/?token=x"));
        assertNull(EacWebTarget.parse("http://localhost:17800/?token=x"));
        assertNull(EacWebTarget.parse("http://example.com:17800/?token=x"));
    }
}
