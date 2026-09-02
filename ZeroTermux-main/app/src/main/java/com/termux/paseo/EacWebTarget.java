package com.termux.paseo;

import java.net.URI;
import java.net.URISyntaxException;

/**
 * The two URLs derived from the {@code webUrl} the EAC sidecar reports.
 *
 * <p>Since kernel 0.1.2 the ready line carries a <em>single-use</em> token
 * ({@code http://127.0.0.1:<port>/?token=X}). Opening it performs a 303 exchange that sets an
 * auth cookie and burns the token, so it works exactly once. Every later "go home" has to use the
 * bare origin; reusing the token URL returns 401 and a blank page.
 *
 * <p>Kept free of android APIs so it is unit testable without Robolectric.
 */
final class EacWebTarget {
    private final String initialUrl;
    private final String homeUrl;
    private final int port;

    private EacWebTarget(String initialUrl, String homeUrl, int port) {
        this.initialUrl = initialUrl;
        this.homeUrl = homeUrl;
        this.port = port;
    }

    /** Returns null when the sidecar reported something unusable, so callers can report a failure. */
    static EacWebTarget parse(String webUrl) {
        if (webUrl == null || webUrl.trim().isEmpty()) return null;
        final URI uri;
        try {
            uri = new URI(webUrl.trim());
        } catch (URISyntaxException malformed) {
            return null;
        }
        int port = uri.getPort();
        if (port <= 0 || !"http".equalsIgnoreCase(uri.getScheme()) ||
            !"127.0.0.1".equals(uri.getHost())) {
            return null;
        }

        String path = uri.getPath() == null || uri.getPath().isEmpty() ? "/" : uri.getPath();
        String home = uri.getScheme() + "://" + uri.getHost() + ":" + port + path;
        return new EacWebTarget(webUrl.trim(), home, port);
    }

    /** Load this once: it carries the one-time token. */
    String initialUrl() {
        return initialUrl;
    }

    /** Token stripped; safe to load repeatedly once the auth cookie is set. */
    String homeUrl() {
        return homeUrl;
    }

    int port() {
        return port;
    }
}
