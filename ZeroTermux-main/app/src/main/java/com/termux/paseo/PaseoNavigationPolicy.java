package com.termux.paseo;

import java.net.URI;
import java.net.InetAddress;
import java.net.UnknownHostException;

final class PaseoNavigationPolicy {
    enum Decision {
        ALLOW_LOCAL,
        OPEN_HOME,
        OPEN_EXTERNAL,
        BLOCK
    }

    private static final String LOCAL_SCHEME = "http";
    private static final String LOCAL_HOST = "127.0.0.1";
    private PaseoNavigationPolicy() {
    }

    static Decision decide(String url) {
        return decide(url, PaseoPortConfig.DEFAULT_PORT);
    }

    static Decision decide(String url, int port) {
        if (url == null) return Decision.BLOCK;

        final URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException error) {
            return Decision.BLOCK;
        }

        String scheme = uri.getScheme();
        String host = uri.getHost();
        if ("paseo".equalsIgnoreCase(scheme) && "open".equalsIgnoreCase(host)) {
            return Decision.OPEN_HOME;
        }
        int localPort = PaseoPortConfig.normalize(port);
        if (LOCAL_SCHEME.equalsIgnoreCase(scheme) && LOCAL_HOST.equals(host) && uri.getPort() == localPort) {
            return Decision.ALLOW_LOCAL;
        }
        if (("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) &&
            host != null && !host.isEmpty()) {
            if (isLoopbackHost(host)) {
                return Decision.BLOCK;
            }
            return Decision.OPEN_EXTERNAL;
        }
        return Decision.BLOCK;
    }

    private static boolean isLoopbackHost(String host) {
        if (LOCAL_HOST.equalsIgnoreCase(host) || "localhost".equalsIgnoreCase(host)) {
            return true;
        }

        // URI.getHost() retains brackets around IPv6 literals. Strip them before
        // asking the platform parser so mapped IPv4 loopback addresses are covered.
        String normalized = host;
        if (normalized.length() > 1 && normalized.charAt(0) == '[' &&
            normalized.charAt(normalized.length() - 1) == ']') {
            normalized = normalized.substring(1, normalized.length() - 1);
        }
        if (normalized.indexOf(':') < 0) return false;
        try {
            return InetAddress.getByName(normalized).isLoopbackAddress();
        } catch (UnknownHostException error) {
            return false;
        }
    }
}
