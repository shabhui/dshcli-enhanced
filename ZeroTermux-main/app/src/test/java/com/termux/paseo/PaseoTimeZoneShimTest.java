package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * EAC 服务端拒绝非法时区,原文:
 * {@code clientTimeZone must be UTC or a valid IANA Area/Location name (invalid-time-zone)}。
 *
 * <p>Android 的 {@code persist.sys.timezone} 可能是 POSIX 别名(模拟器默认 {@code GMT}),
 * ICU 映射不到 IANA 名,于是 Chromium 的
 * {@code Intl.DateTimeFormat().resolvedOptions().timeZone} 退化成偏移量字符串
 * {@code "+00:00"} —— 真机上量到的就是这个值。发消息因此 100% 失败。
 *
 * <p>判定规则刻意照抄服务端那句报错(UTC 或含 {@code /} 的 Area/Location),
 * 而不是自己另立一套 —— 猜规则就会在别的机型上再错一次。
 */
public class PaseoTimeZoneShimTest {

    @Test
    public void keepsARealIanaZoneUntouched() {
        assertEquals("Asia/Shanghai",
            PaseoTimeZoneShim.chooseZone("Asia/Shanghai", "Asia/Shanghai"));
        assertEquals("America/Argentina/Buenos_Aires",
            PaseoTimeZoneShim.chooseZone("America/Argentina/Buenos_Aires", "GMT"));
    }

    @Test
    public void keepsUtcBecauseTheServerNamesItExplicitly() {
        assertEquals("UTC", PaseoTimeZoneShim.chooseZone("UTC", "GMT"));
    }

    @Test
    public void replacesTheOffsetStringThatChromiumFallsBackTo() {
        // 真机实测值。服务端只接受 UTC 或 Area/Location,偏移量必被拒。
        assertEquals("UTC", PaseoTimeZoneShim.chooseZone("+00:00", "GMT"));
        assertEquals("UTC", PaseoTimeZoneShim.chooseZone("-05:00", "GMT"));
    }

    @Test
    public void prefersTheAndroidZoneWhenItIsTheOnlyValidOne() {
        // WebView 退化成偏移量,但系统本身知道真正的 IANA 名 —— 用后者,
        // 直接落到 UTC 会把时间错开好几个小时。
        assertEquals("Asia/Shanghai", PaseoTimeZoneShim.chooseZone("+08:00", "Asia/Shanghai"));
        assertEquals("Europe/Berlin", PaseoTimeZoneShim.chooseZone("GMT+01:00", "Europe/Berlin"));
    }

    @Test
    public void fallsBackToUtcWhenNeitherSideIsUsable() {
        assertEquals("UTC", PaseoTimeZoneShim.chooseZone("GMT", "GMT"));
        assertEquals("UTC", PaseoTimeZoneShim.chooseZone(null, null));
        assertEquals("UTC", PaseoTimeZoneShim.chooseZone("", ""));
        // EST/MST 这类无斜杠的旧式名不符合服务端那句话,不能放过。
        assertEquals("UTC", PaseoTimeZoneShim.chooseZone("EST", "EST"));
    }

    @Test
    public void rejectsZoneNamesThatCouldBreakOutOfTheScriptString() {
        // 时区名最终要进单引号 JS 字符串。带引号或反斜杠的值一律不接受,
        // 而不是转义了再用 —— 合法 IANA 名里不会有这些字符。
        assertEquals("UTC", PaseoTimeZoneShim.chooseZone("A/'+alert(1)+'", "GMT"));
        assertEquals("UTC", PaseoTimeZoneShim.chooseZone("A/\\", "GMT"));
        assertEquals("UTC", PaseoTimeZoneShim.chooseZone("A/B\nC", "GMT"));
    }

    @Test
    public void injectionScriptCarriesTheChosenZoneAndIsSingleLine() {
        String script = PaseoTimeZoneShim.injectionScript("Asia/Shanghai");

        assertTrue(script.contains("Asia/Shanghai"));
        assertTrue("必须改 resolvedOptions,那是内核读时区的入口",
            script.contains("resolvedOptions"));
        assertEquals("必须单行,evaluateJavascript 才安全", -1, script.indexOf('\n'));
        assertFalse("脚本自身不能带换行或反斜杠转义", script.contains("\\"));
    }

    @Test
    public void injectionScriptOnlyRewritesInvalidZones() {
        String script = PaseoTimeZoneShim.injectionScript("UTC");

        // 页面里已是合法 Area/Location 时不要动 —— 那是设备的真实时区,
        // 覆盖它会把时间戳改错。
        assertTrue(script.contains("indexOf('/')"));
    }
}
