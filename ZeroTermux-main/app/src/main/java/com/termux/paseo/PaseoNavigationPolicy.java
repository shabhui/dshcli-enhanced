package com.termux.paseo;

import java.net.URI;
import java.net.InetAddress;
import java.net.UnknownHostException;

final class PaseoNavigationPolicy {
    enum Decision {
        ALLOW_LOCAL,
        /** 命中当前「连接电脑」目标的 origin,留在 WebView 里。 */
        ALLOW_REMOTE,
        OPEN_HOME,
        OPEN_EXTERNAL,
        BLOCK
    }

    private static final String LOCAL_SCHEME = "http";
    private static final String LOCAL_HOST = "127.0.0.1";
    private PaseoNavigationPolicy() {
    }

    /**
     * 「连接电脑」期间的判定。远程 DSH 是个完整的 SPA,站内跳转必须留在 WebView 里 ——
     * 否则每点一下就弹一次系统浏览器,而且系统浏览器里没有那张 auth cookie。
     *
     * <p>只放行<b>完全相同</b>的 origin(scheme + host + port)。跨站链接仍然交给外部浏览器,
     * 所以远程页面上的第三方链接不会静默地在我们的 WebView 里打开。
     *
     * @param remoteOrigin {@link PaseoRemoteTarget#origin()};{@code null} 表示当前没连电脑,
     *                     此时行为与 {@link #decideExact} 完全一致。
     */
    static Decision decideWithRemote(String url, int localPort, String remoteOrigin) {
        if (url == null) return Decision.BLOCK;
        if (remoteOrigin != null && !remoteOrigin.isEmpty() && matchesOrigin(url, remoteOrigin)) {
            return Decision.ALLOW_REMOTE;
        }
        return decideOn(url, localPort);
    }

    /** 按 scheme/host/port 三元组比对,而不是字符串前缀 —— 前缀会把 host 的兄弟域名也放进来。 */
    private static boolean matchesOrigin(String url, String origin) {
        final URI candidate;
        final URI reference;
        try {
            candidate = URI.create(url);
            reference = URI.create(origin);
        } catch (IllegalArgumentException malformed) {
            return false;
        }
        String candidateScheme = candidate.getScheme();
        String referenceScheme = reference.getScheme();
        if (candidateScheme == null || referenceScheme == null) return false;
        if (!candidateScheme.equalsIgnoreCase(referenceScheme)) return false;

        String candidateHost = candidate.getHost();
        String referenceHost = reference.getHost();
        if (candidateHost == null || referenceHost == null) return false;
        if (!candidateHost.equalsIgnoreCase(referenceHost)) return false;

        // 远程 origin 总是显式带端口(PaseoRemoteTarget 会补默认值),所以缺省端口的
        // 站内相对跳转要按 scheme 的默认端口补齐,否则同一个站会被判成不同 origin。
        int candidatePort = candidate.getPort();
        if (candidatePort == -1) {
            candidatePort = "https".equalsIgnoreCase(candidateScheme) ? 443 : 80;
        }
        return candidatePort == reference.getPort();
    }

    static Decision decide(String url) {
        return decide(url, PaseoPortConfig.DEFAULT_PORT);
    }

    /** Port comes from user input, so it is normalized first. */
    static Decision decide(String url, int port) {
        return decideOn(url, PaseoPortConfig.normalize(port));
    }

    /**
     * Compares {@code port} exactly. For the port the EAC sidecar reports: it is the port the web
     * service actually bound, so normalizing it would rewrite a legitimate value (a reported 6768
     * or 80 becomes 6767) and then BLOCK every in-page navigation.
     */
    static Decision decideExact(String url, int port) {
        return decideOn(url, port);
    }

    private static Decision decideOn(String url, int localPort) {
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
