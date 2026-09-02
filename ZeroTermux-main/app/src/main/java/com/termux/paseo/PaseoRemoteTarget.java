package com.termux.paseo;

import java.net.URI;
import java.net.URISyntaxException;

/**
 * 电脑上那台 DSH 的地址 —— 「连接电脑」用它把 WebView 指过去。
 *
 * <p>方向和桌面版的 {@code dsh-phone} 相反:桌面版把<b>自己</b>的界面挂到局域网上等手机来扫,
 * 我们这边是手机<b>主动去连</b>电脑,看电脑上的进度。所以这里不开任何监听端口,只发出站请求 ——
 * 要暴露什么由电脑那侧决定,不是我们。
 *
 * <p>Token 规则和本机 sidecar 一样({@link EacWebTarget} 里有完整原因):内核打印的地址带
 * <b>一次性</b> token,{@code /?token=X} 换一次 cookie 就作废。所以首次加载用用户粘贴的原串,
 * 之后每次回首页只能用裸 origin,否则 401 + 白屏。
 *
 * <p>刻意<b>拒绝回环地址</b>。{@code 127.0.0.1} / {@code localhost} 指的是这台手机自己,
 * 填进来只会连到本机 sidecar,却绕过了控制页那套启动/停止状态机 —— 那不是「连接电脑」,
 * 是把本地入口复制了一份,状态还会打架。想连本机就用「进入」。
 *
 * <p>不碰任何 android API,好让它能脱离 Robolectric 做单元测试。
 */
final class PaseoRemoteTarget {

    /** 用户没写端口时的默认值,与内核 {@code dsh web} 的默认监听一致。 */
    static final int DEFAULT_REMOTE_PORT = PaseoPortConfig.DEFAULT_PORT;

    private final String initialUrl;
    private final String homeUrl;
    private final String origin;
    private final String host;
    private final int port;

    private PaseoRemoteTarget(String initialUrl, String homeUrl, String origin,
                              String host, int port) {
        this.initialUrl = initialUrl;
        this.homeUrl = homeUrl;
        this.origin = origin;
        this.host = host;
        this.port = port;
    }

    /**
     * 解析用户输入。刻意宽进严出 —— 用户可能粘贴内核打印的整条带 token 的 URL,也可能只手敲
     * {@code 192.168.1.7:6767},甚至只写一个 IP。
     *
     * @return 解析不出可用目标时返回 {@code null},由调用方提示,而不是猜一个地址去连。
     */
    static PaseoRemoteTarget parse(String input) {
        if (input == null) return null;
        String raw = input.trim();
        if (raw.isEmpty()) return null;
        // 空白字符不可能出现在合法 URL 里,但很容易从聊天软件粘进来。
        if (raw.matches(".*\\s.*")) return null;

        // 只有<b>完全没有</b>协议时才补 http://,否则 URI 会把 "192.168.1.7:6767" 的
        // 主机名当成 scheme。不能只判断 http/https —— 那样 "ftp://host" 会被补成
        // "http://ftp://host",URI 反而把 ftp 解析成主机名,于是非法协议被放行。
        boolean hasScheme = raw.matches("(?i)^[a-z][a-z0-9+.-]*://.*");
        if (hasScheme && !raw.matches("(?i)^https?://.*")) return null;
        String candidate = hasScheme ? raw : "http://" + raw;

        final URI uri;
        try {
            uri = new URI(candidate);
        } catch (URISyntaxException malformed) {
            return null;
        }

        String scheme = uri.getScheme();
        if (scheme == null) return null;
        scheme = scheme.toLowerCase();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null;

        String parsedHost = uri.getHost();
        if (parsedHost == null || parsedHost.isEmpty()) return null;
        // 回环是这台手机自己,不是「电脑」。理由见类注释。
        if (isLoopback(parsedHost)) return null;

        int parsedPort = uri.getPort();
        if (parsedPort == -1) {
            parsedPort = "https".equals(scheme) ? 443 : DEFAULT_REMOTE_PORT;
        } else if (parsedPort < 1 || parsedPort > 65535) {
            return null;
        }

        String authority = parsedHost.indexOf(':') >= 0 && parsedHost.charAt(0) != '['
            ? "[" + parsedHost + "]"   // 裸 IPv6:URI 会剥掉方括号,拼回去才是合法 origin
            : parsedHost;
        String resolvedOrigin = scheme + "://" + authority + ":" + parsedPort;

        String path = uri.getPath() == null || uri.getPath().isEmpty() ? "/" : uri.getPath();
        String home = resolvedOrigin + path;

        // 用户粘的原串可能带 token / 查询串,首次加载必须原样用。
        String initial = candidate;
        return new PaseoRemoteTarget(initial, home, resolvedOrigin, parsedHost, parsedPort);
    }

    private static boolean isLoopback(String host) {
        String normalized = host;
        if (normalized.length() > 1 && normalized.charAt(0) == '['
            && normalized.charAt(normalized.length() - 1) == ']') {
            normalized = normalized.substring(1, normalized.length() - 1);
        }
        if ("localhost".equalsIgnoreCase(normalized)) return true;
        // 整个 127.0.0.0/8 都是回环,不只 127.0.0.1。
        if (normalized.matches("127(\\.\\d{1,3}){3}")) return true;
        return "::1".equals(normalized) || "0:0:0:0:0:0:0:1".equalsIgnoreCase(normalized);
    }

    /** 只加载一次:可能带一次性 token。 */
    String initialUrl() {
        return initialUrl;
    }

    /** 去掉查询串,cookie 建好后可以反复加载。 */
    String homeUrl() {
        return homeUrl;
    }

    /** {@code scheme://host:port},导航判定按它比对。 */
    String origin() {
        return origin;
    }

    String host() {
        return host;
    }

    int port() {
        return port;
    }

    /** 控制页上显示给用户的短标签。 */
    String label() {
        return host + ":" + port;
    }
}
