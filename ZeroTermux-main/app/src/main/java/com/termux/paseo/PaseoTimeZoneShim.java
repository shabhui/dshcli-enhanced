package com.termux.paseo;

import java.util.TimeZone;

/**
 * 让 EAC Web UI 报出一个服务端能接受的时区。
 *
 * <p>服务端的原话是:
 * {@code clientTimeZone must be UTC or a valid IANA Area/Location name (invalid-time-zone)}。
 * 而 Android 的 {@code persist.sys.timezone} 允许 POSIX 别名(模拟器默认就是 {@code GMT}),
 * ICU 映射不到 IANA 名时,Chromium 的
 * {@code Intl.DateTimeFormat().resolvedOptions().timeZone} 会退化成偏移量字符串 ——
 * 真机上量到的是 {@code "+00:00"}。内核发消息时带上这个值,服务端必拒,于是
 * 「用模型」100% 失败,而报错内容和时区八竿子打不着,很难往这边想。
 *
 * <p>判定规则照抄服务端那句报错(UTC,或含 {@code /} 的 Area/Location),不自立标准 ——
 * 猜规则只会在别的机型上再错一次。取值优先级:页面里本来就合法就不动它(那是设备真实时区,
 * 覆盖会写错时间戳);否则用 Android 侧的 zone ID(它常常知道真正的 IANA 名);
 * 两边都不可用才落到 {@code UTC}。
 */
final class PaseoTimeZoneShim {

    /** 服务端明确允许的兜底值。 */
    static final String FALLBACK = "UTC";

    private PaseoTimeZoneShim() {
    }

    /**
     * 选出要报给服务端的时区名。
     *
     * @param webViewZone 页面里 {@code Intl} 解析出的值,可能是 {@code "+00:00"} 这类偏移量
     * @param androidZone {@code TimeZone.getDefault().getID()},可能是 {@code "GMT"}
     */
    static String chooseZone(String webViewZone, String androidZone) {
        if (isAcceptable(webViewZone)) return webViewZone;
        if (isAcceptable(androidZone)) return androidZone;
        return FALLBACK;
    }

    /** 当前设备的选择结果。 */
    static String currentZone() {
        // WebView 侧的值只有页面里才拿得到,所以这里只判 Android 侧;
        // 页面里是否已经合法由注入脚本自己决定(见 injectionScript)。
        TimeZone def = TimeZone.getDefault();
        return chooseZone(null, def == null ? null : def.getID());
    }

    /**
     * 是否符合服务端那句话:{@code UTC} 或含 {@code /} 的 Area/Location。
     *
     * <p>顺带挡掉带引号、反斜杠、换行的值 —— 结果要进单引号 JS 字符串,而合法 IANA 名
     * 不含这些字符,所以直接拒绝比转义更简单也更安全。
     */
    private static boolean isAcceptable(String zone) {
        if (zone == null || zone.isEmpty()) return false;
        if (zone.indexOf('\'') >= 0 || zone.indexOf('"') >= 0
            || zone.indexOf('\\') >= 0 || zone.indexOf('\n') >= 0
            || zone.indexOf('\r') >= 0) {
            return false;
        }
        if (FALLBACK.equals(zone)) return true;
        return zone.indexOf('/') > 0;
    }

    /**
     * 返回给页面打补丁的一行 JS。只在页面自身的值不合法时改写,合法就原样放过。
     *
     * @param zone 由 {@link #chooseZone} 选出的替代值
     */
    static String injectionScript(String zone) {
        String safe = isAcceptable(zone) ? zone : FALLBACK;
        return "(function(){try{"
            + "var P=Intl.DateTimeFormat.prototype,ro=P.resolvedOptions;"
            + "if(ro.__paseoPatched)return;"
            + "var patched=function(){var o=ro.apply(this,arguments);"
            // 与服务端同一条判据:UTC 或含 / 的 Area/Location 才放过。
            + "if(o&&typeof o.timeZone==='string'"
            + "&&o.timeZone!=='" + FALLBACK + "'&&o.timeZone.indexOf('/')<0)"
            + "{o.timeZone='" + safe + "';}return o;};"
            + "patched.__paseoPatched=true;P.resolvedOptions=patched;"
            + "}catch(e){}})();";
    }
}
