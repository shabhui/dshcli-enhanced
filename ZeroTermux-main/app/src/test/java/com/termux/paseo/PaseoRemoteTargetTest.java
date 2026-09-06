package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 「连接电脑」的地址由用户手敲或粘贴,所以这里是宽进严出的边界:
 * 能认的形状要都认下来,认不出的一律返回 null,绝不猜一个地址去连。
 *
 * <p>其中「拒绝回环」是刻意的设计约束而非疏漏 —— 填 127.0.0.1 会连到本机 sidecar,
 * 却绕开控制页的启动/停止状态机,两个入口的状态会打架。
 */
public class PaseoRemoteTargetTest {

    @Test
    public void acceptsAPlainHostAndPortTheUserTypes() {
        PaseoRemoteTarget target = PaseoRemoteTarget.parse("192.168.1.7:6767");

        assertNotNull(target);
        assertEquals("http://192.168.1.7:6767", target.origin());
        assertEquals("http://192.168.1.7:6767/", target.homeUrl());
        assertEquals(6767, target.port());
        assertEquals("192.168.1.7:6767", target.label());
    }

    @Test
    public void fillsInTheKernelDefaultPortWhenOmitted() {
        PaseoRemoteTarget target = PaseoRemoteTarget.parse("192.168.1.7");

        assertNotNull(target);
        assertEquals(PaseoPortConfig.DEFAULT_PORT, target.port());
        assertEquals("http://192.168.1.7:6767/", target.homeUrl());
    }

    @Test
    public void keepsTheOneTimeTokenForTheFirstLoadAndStripsItAfterwards() {
        // 内核打印的就是这种整串,用户最可能直接粘贴。
        PaseoRemoteTarget target =
            PaseoRemoteTarget.parse("http://192.168.1.7:6767/?token=abc123");

        assertNotNull(target);
        // 首次必须原样带 token,否则换不到 cookie。
        assertEquals("http://192.168.1.7:6767/?token=abc123", target.initialUrl());
        // 之后必须是裸 origin:token 是一次性的,重用会 401 + 白屏。
        assertEquals("http://192.168.1.7:6767/", target.homeUrl());
    }

    @Test
    public void rejectsLoopbackBecauseThatIsThisPhoneNotAComputer() {
        // 走「进入」才是连本机;从这里连会绕开控制页的状态机。
        assertNull(PaseoRemoteTarget.parse("127.0.0.1:6767"));
        assertNull(PaseoRemoteTarget.parse("localhost:6767"));
        assertNull(PaseoRemoteTarget.parse("http://LocalHost:6767/"));
        assertNull("整个 127.0.0.0/8 都是回环", PaseoRemoteTarget.parse("127.0.0.2:6767"));
        assertNull(PaseoRemoteTarget.parse("[::1]:6767"));
    }

    @Test
    public void rejectsWhatCannotBeAnAddress() {
        assertNull(PaseoRemoteTarget.parse(null));
        assertNull(PaseoRemoteTarget.parse(""));
        assertNull(PaseoRemoteTarget.parse("   "));
        assertNull("协议不对", PaseoRemoteTarget.parse("ftp://192.168.1.7:6767"));
        assertNull("端口越界", PaseoRemoteTarget.parse("192.168.1.7:70000"));
        assertNull("端口为 0", PaseoRemoteTarget.parse("192.168.1.7:0"));
        // 从聊天软件粘贴很容易带进空白,那时宁可报错也不要连错地方。
        assertNull(PaseoRemoteTarget.parse("192.168.1.7 :6767"));
    }

    @Test
    public void handlesHttpsAndItsDefaultPort() {
        PaseoRemoteTarget target = PaseoRemoteTarget.parse("https://dsh.example.com");

        assertNotNull(target);
        assertEquals(443, target.port());
        assertEquals("https://dsh.example.com:443", target.origin());
    }

    @Test
    public void keepsIpv6LiteralsBracketedSoTheOriginStaysValid() {
        // URI.getHost() 会剥掉方括号,拼 origin 时必须补回去。
        PaseoRemoteTarget target = PaseoRemoteTarget.parse("http://[fd00::1]:6767/");

        assertNotNull(target);
        assertEquals("http://[fd00::1]:6767", target.origin());
        assertEquals("http://[fd00::1]:6767/", target.homeUrl());
    }

    @Test
    public void preservesThePathTheUserPasted() {
        PaseoRemoteTarget target = PaseoRemoteTarget.parse("http://192.168.1.7:6767/chat");

        assertNotNull(target);
        assertEquals("http://192.168.1.7:6767/chat", target.homeUrl());
    }

    /**
     * 接线是这个功能真正会坏的地方,而 Activity 起不了 JVM 单测,所以按源码结构断言。
     * 每一条都对应一个具体的、我能说清后果的失效。
     */
    @Test
    public void activityWiresTheComputerButtonToAnOutboundOnlyTarget() throws Exception {
        String activity = new String(
            java.nio.file.Files.readAllBytes(
                new java.io.File("src/main/java/com/termux/paseo/PaseoActivity.java").toPath()),
            java.nio.charset.StandardCharsets.UTF_8);

        // 按钮没监听就是个死按钮 —— 布局里加了控件却接不上,是最容易漏的一步。
        assertTrue(activity.contains("R.id.paseo_connect_computer"));
        assertTrue(activity.contains("showRemoteDialog()"));

        // 存 origin 而不是原始输入:token 一次性,存下来下次进入必然 401。
        assertTrue(activity.contains("putString(KEY_REMOTE_ORIGIN, target.origin())"));
        assertFalse("不能把带 token 的原始地址存进 SharedPreferences",
            activity.contains("putString(KEY_REMOTE_ORIGIN, target.initialUrl())"));

        // 首次带 token、之后裸 origin,与本机 eacTarget 同一条规则。
        assertTrue(activity.contains(
            "initialRemoteUrlPending ? remoteTarget.initialUrl() : remoteTarget.homeUrl()"));

        // 两个导航入口都必须走远程判定,否则连着电脑时站内跳转会被 BLOCK 成白屏。
        assertTrue(activity.contains("PaseoNavigationPolicy.decideWithRemote("));
        assertEquals("handleNavigation、handlePopupNavigation 和本机桥接守卫都要走同一个判定",
            3, countOccurrences(activity, "decideNavigation(url)"));
        // decideExact 只剩校验 sidecar 目标那一处,那一处必须留着 ——
        // 它比的是 sidecar 实际绑定的端口,换成会 normalize 的版本就等于改掉事实。
        assertEquals("decideExact 只应出现在校验 sidecar 目标的地方",
            1, countOccurrences(activity, "PaseoNavigationPolicy.decideExact("));
        assertTrue(activity.contains(
            "PaseoNavigationPolicy.decideExact(target.initialUrl(), target.port())"));

        // 只出站:这个功能不能顺手在本机开监听端口。
        assertFalse(activity.contains("ServerSocket"));

        // cookie 不落盘的话,进程一死就只剩一个用过的 token。
        assertTrue(activity.contains("CookieManager.getInstance().flush()"));
    }

    /**
     * 明文策略是这个功能的硬前提,而它不在 Java 里 —— 真机验证过:base-config 为 false 时
     * 请求在平台层就被丢掉,服务端收不到任何东西、logcat 不报错、只剩白屏。
     * 有人为了「加固」把它改回去,这个测试要立刻红,而不是等用户报「连不上」。
     */
    @Test
    public void cleartextMustStayPermittedOrConnectingToAComputerSilentlyFails()
            throws Exception {
        String config = new String(
            java.nio.file.Files.readAllBytes(
                new java.io.File("src/main/res/xml/network_security_config.xml").toPath()),
            java.nio.charset.StandardCharsets.UTF_8);

        assertTrue("base-config 必须放行明文,否则局域网 http 在平台层就被丢掉",
            config.contains("<base-config cleartextTrafficPermitted=\"true\" />"));
        assertFalse("不能把 base-config 改回禁止明文",
            config.contains("cleartextTrafficPermitted=\"false\""));
        assertFalse("诊断用的模拟器专用条目不该留在仓库里",
            config.contains("10.0.2.2"));
    }

    private static int countOccurrences(String haystack, String needle) {
        int count = 0;
        for (int at = haystack.indexOf(needle); at >= 0;
             at = haystack.indexOf(needle, at + needle.length())) {
            count++;
        }
        return count;
    }
}
