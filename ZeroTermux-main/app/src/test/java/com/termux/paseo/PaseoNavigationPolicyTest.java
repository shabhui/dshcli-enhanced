package com.termux.paseo;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class PaseoNavigationPolicyTest {

    @Test
    public void allowsOnlyTheEmbeddedPaseoHttpOrigin() {
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_LOCAL,
            PaseoNavigationPolicy.decide("http://127.0.0.1:6767/"));
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_LOCAL,
            PaseoNavigationPolicy.decide("http://127.0.0.1:6767/session?id=1#output"));

        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("https://127.0.0.1:6767/"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("http://localhost:6767/"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("http://127.0.0.1:6768/"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("http://127.0.0.1:6767.evil.example/"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("http://[::1]:6767/"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("http://[::ffff:127.0.0.1]:6767/"));
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_EXTERNAL,
            PaseoNavigationPolicy.decide("https://example.com/"));
    }

    @Test
    public void allowsOnlyTheCurrentlySelectedEmbeddedPort() {
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_LOCAL,
            PaseoNavigationPolicy.decide("http://127.0.0.1:8080/project", 8080));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("http://127.0.0.1:6767/project", 8080));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("http://127.0.0.1:6768/project", 6768));
    }

    @Test
    public void mapsTheAppOpenLinkToHomeAndBlocksInvalidUrls() {
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_HOME,
            PaseoNavigationPolicy.decide("paseo://open"));
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_HOME,
            PaseoNavigationPolicy.decide("paseo://open/project/123"));

        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("paseo://settings"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("not a url"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide(null));
    }

    @Test
    public void sendsHttpAndHttpsProviderDocumentationToTheSystemBrowser() {
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_EXTERNAL,
            PaseoNavigationPolicy.decide("https://docs.example.com/providers#claude"));
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_EXTERNAL,
            PaseoNavigationPolicy.decide("http://registry.example.com/install"));

        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("https://127.0.0.1:6767/"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("http://127.0.0.1:6768/"));
    }
}
