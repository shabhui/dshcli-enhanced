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
    public void comparesTheSidecarReportedPortExactlyWithoutNormalising() {
        // The EAC sidecar reports the port its web service actually bound. That is a fact, not
        // user input, so it must not go through normalize(): a reported 6768 or 80 would be
        // rewritten to 6767 and then every in-page navigation would be BLOCKed with a white
        // screen and no explanation.
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_LOCAL,
            PaseoNavigationPolicy.decideExact("http://127.0.0.1:6768/session", 6768));
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_LOCAL,
            PaseoNavigationPolicy.decideExact("http://127.0.0.1:80/session", 80));
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_LOCAL,
            PaseoNavigationPolicy.decideExact("http://127.0.0.1:17800/?token=abc", 17800));

        // Everything else keeps the same semantics as decide().
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decideExact("http://127.0.0.1:17801/", 17800));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decideExact("http://localhost:17800/", 17800));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decideExact("https://127.0.0.1:17800/", 17800));
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_EXTERNAL,
            PaseoNavigationPolicy.decideExact("https://example.com/", 17800));
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_HOME,
            PaseoNavigationPolicy.decideExact("paseo://open", 17800));
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
    public void keepsTheConnectedComputerInsideTheWebView() {
        String origin = "http://192.168.1.7:6767";

        // 远程 DSH 是完整 SPA:站内跳转必须留在 WebView。丢给系统浏览器的话每点一下
        // 弹一个标签,而且那边没有换来的 auth cookie。
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_REMOTE,
            PaseoNavigationPolicy.decideWithRemote("http://192.168.1.7:6767/", 6767, origin));
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_REMOTE,
            PaseoNavigationPolicy.decideWithRemote(
                "http://192.168.1.7:6767/session?id=1#out", 6767, origin));
    }

    @Test
    public void stillReachesTheLocalSidecarWhileConnectedToAComputer() {
        // 连着电脑时本机入口不能失效 —— 控制页的「进入」还要能用。
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_LOCAL,
            PaseoNavigationPolicy.decideWithRemote(
                "http://127.0.0.1:6767/", 6767, "http://192.168.1.7:6767"));
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_HOME,
            PaseoNavigationPolicy.decideWithRemote(
                "paseo://open", 6767, "http://192.168.1.7:6767"));
    }

    @Test
    public void doesNotLetANeighbouringOriginRideAlong() {
        String origin = "http://192.168.1.7:6767";

        // 端口不同就是另一个 origin。
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_EXTERNAL,
            PaseoNavigationPolicy.decideWithRemote("http://192.168.1.7:9999/", 6767, origin));
        // 主机不同同理 —— 用前缀比对就会把 192.168.1.70 也放进来。
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_EXTERNAL,
            PaseoNavigationPolicy.decideWithRemote("http://192.168.1.70:6767/", 6767, origin));
        // 协议不同也是另一个 origin,cookie 也不共享。
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_EXTERNAL,
            PaseoNavigationPolicy.decideWithRemote("https://192.168.1.7:6767/", 6767, origin));
        // 远程页面上的第三方链接仍然走系统浏览器。
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_EXTERNAL,
            PaseoNavigationPolicy.decideWithRemote("https://github.com/", 6767, origin));
    }

    @Test
    public void behavesExactlyAsBeforeWhenNoComputerIsConnected() {
        // 没连电脑时必须与原判定一致,否则等于给未使用的功能改了既有行为。
        for (String url : new String[] {
            "http://127.0.0.1:6767/", "paseo://open", "https://github.com/",
            "http://localhost:6767/", "not a url", "http://127.0.0.1:9999/",
        }) {
            assertEquals(url, PaseoNavigationPolicy.decideExact(url, 6767),
                PaseoNavigationPolicy.decideWithRemote(url, 6767, null));
            assertEquals(url, PaseoNavigationPolicy.decideExact(url, 6767),
                PaseoNavigationPolicy.decideWithRemote(url, 6767, ""));
        }
    }

    @Test
    public void matchesAnImplicitDefaultPortAgainstTheExplicitOrigin() {
        // 远程 origin 总是显式带端口,而站内相对跳转可能省略默认端口。
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_REMOTE,
            PaseoNavigationPolicy.decideWithRemote(
                "https://dsh.example.com/chat", 6767, "https://dsh.example.com:443"));
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_REMOTE,
            PaseoNavigationPolicy.decideWithRemote(
                "http://dsh.example.com/chat", 6767, "http://dsh.example.com:80"));
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
