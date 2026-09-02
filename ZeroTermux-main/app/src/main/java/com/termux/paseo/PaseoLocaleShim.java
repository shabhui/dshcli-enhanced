package com.termux.paseo;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.regex.Pattern;

/**
 * 让 {@code navigator.language} 报出 EAC 自己配置的界面语言。
 *
 * <p>症状是「插件设置那页不是中文」:设置面板左侧 24 个标签全是中文,右侧插件市场却整页英文
 * (Install / Not installed / Re-probe / Checking…)。
 *
 * <p>根因不是缺翻译 —— {@code dsh-unified-market} 自带一份<b>完整的中文表</b>,只是选错了分支:
 *
 * <pre>
 * let LOCALE = 'en'
 * const nl = String(navigator.language || navigator.userLanguage || '')
 * if (nl.toLowerCase().startsWith('zh')) LOCALE = 'zh'
 * </pre>
 *
 * <p>它读<b>浏览器</b>语言,而不是 EAC 的界面语言设置。而 Android WebView 的
 * {@code navigator.language} 跟随<b>应用</b>语言(真机实测:{@code cmd locale set-app-locales}
 * 设成 zh-CN 后它就从 {@code en-US} 变成 {@code zh-CN})。于是只要手机语言不是中文,这一页
 * 就是英文 —— 即使用户已经在 EAC 里把语言选成「中文」。
 *
 * <p><b>为什么不读 {@code <html lang>}。</b>它看起来是天然的信号,实测却不可用 ——
 * 真机上打了时间戳:
 *
 * <table border="1">
 *   <tr><th>时刻</th><th>{@code <html lang>}</th></tr>
 *   <tr><td>0ms(document-start)</td><td>{@code null}</td></tr>
 *   <tr><td>11ms</td><td>{@code en} ← 服务端发的静态外壳</td></tr>
 *   <tr><td>758ms</td><td>{@code zh-CN} ← EAC 应用用户设置</td></tr>
 * </table>
 *
 * <p>而插件读 {@code navigator.language} 的时刻是 <b>2ms</b>。那一刻语言在页面里根本还不存在;
 * 到 11ms 更糟 —— 会读到静态外壳的 {@code en},比读不到还容易误判。所以任何基于
 * {@code <html lang>} 的方案都无解:信息在被读取时尚未产生。
 *
 * <p>可用的权威源在磁盘上 —— EAC 自己就把界面语言持久化在 {@code ~/.dsh/settings.yaml}:
 *
 * <pre>
 * locale:
 *   preference: zh
 * </pre>
 *
 * <p>这是 EAC 本身读的同一份配置,所以这里不是猜、也不硬编码中文:英文界面读到 {@code en}
 * 就报 {@code en},缺配置或写着 {@code auto} 就<b>完全不注入</b>,浏览器原值保持不动。
 *
 * <p>注入点是 {@code onPageStarted}:插件的 {@code LOCALE} 是模块级常量,只在 client.js
 * 求值时算一次(实测整页只读一次,发生在 2ms)。真机验证过 {@code onPageFinished} 之后再改
 * {@code navigator.language} 并重挂载市场是<b>无效</b>的 —— 2821 行全部重建,字符串仍是英文。
 */
final class PaseoLocaleShim {

    /** 幂等标记;注入点可能被调用多次,只有第一次生效。 */
    static final String FLAG = "__paseoLocaleShim";

    /** EAC 持久化界面语言的位置,相对 {@code $HOME}。 */
    private static final String SETTINGS_PATH = ".dsh/settings.yaml";

    /**
     * 合法的语言标签。限定字符集同时保证了值可以直接放进单引号 JS 字符串 ——
     * 只有字母、数字和连字符,不可能出现引号或反斜杠。
     */
    private static final Pattern LANGUAGE_TAG =
        Pattern.compile("[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*");

    /** 表示「跟随系统」的取值:这时不该覆盖,浏览器原值才是对的。 */
    private static final Pattern FOLLOW_SYSTEM =
        Pattern.compile("auto|system|default", Pattern.CASE_INSENSITIVE);

    private PaseoLocaleShim() {
    }

    /**
     * 读出 EAC 配置的界面语言。
     *
     * @return 语言标签(如 {@code zh});没有配置、配置为「跟随系统」或读不到时返回
     *         {@code null},调用方应当<b>不注入</b>而不是注入一个猜测值。
     */
    static String preferredLanguage(File homeDirectory) {
        if (homeDirectory == null) return null;
        File settings = new File(homeDirectory, SETTINGS_PATH);
        if (!settings.isFile()) return null;
        try {
            return parsePreference(new String(
                Files.readAllBytes(settings.toPath()), StandardCharsets.UTF_8));
        } catch (IOException | RuntimeException error) {
            // 读不到就不覆盖 —— 这条路径纯属锦上添花,不该拖垮页面加载。
            return null;
        }
    }

    /**
     * 从 settings.yaml 里取 {@code locale.preference}。
     *
     * <p>刻意手写而不引入 YAML 依赖:只认一种结构,认不出就返回 {@code null}。
     * 必须限定在 {@code locale:} 块内 —— 别的块也可能有 {@code preference:}。
     */
    static String parsePreference(String yaml) {
        if (yaml == null) return null;
        boolean inLocaleBlock = false;
        for (String rawLine : yaml.split("\n")) {
            String line = stripComment(rawLine);
            if (line.trim().isEmpty()) continue;

            boolean indented = line.startsWith(" ") || line.startsWith("\t");
            if (!indented) {
                // 顶层键:进入或离开 locale 块。
                inLocaleBlock = "locale:".equals(line.trim());
                continue;
            }
            if (!inLocaleBlock) continue;

            String trimmed = line.trim();
            if (!trimmed.startsWith("preference:")) continue;
            String value = unquote(trimmed.substring("preference:".length()).trim());
            if (value.isEmpty()) return null;
            if (FOLLOW_SYSTEM.matcher(value).matches()) return null;
            return LANGUAGE_TAG.matcher(value).matches() ? value : null;
        }
        return null;
    }

    private static String stripComment(String line) {
        int hash = line.indexOf('#');
        return hash < 0 ? line : line.substring(0, hash);
    }

    private static String unquote(String value) {
        if (value.length() >= 2
            && ((value.startsWith("'") && value.endsWith("'"))
                || (value.startsWith("\"") && value.endsWith("\"")))) {
            return value.substring(1, value.length() - 1);
        }
        return value;
    }

    /**
     * 返回覆盖 {@code navigator.language} / {@code navigator.languages} 的一行 JS。
     * 两个属性都定义在 {@code Navigator.prototype} 上且只有 getter,所以只能在实例上
     * {@code defineProperty} 覆盖。
     *
     * @param language {@link #preferredLanguage} 的返回值;{@code null} 或不合法时返回空串,
     *                 表示无事可做。
     */
    static String injectionScript(String language) {
        if (language == null || !LANGUAGE_TAG.matcher(language).matches()) return "";
        return "(function(){var w=window,n=w.navigator;"
            + "if(w." + FLAG + ")return;w." + FLAG + "=true;"
            + "var lang='" + language + "';"
            + "var realList=n.languages;"
            + "try{"
            + "Object.defineProperty(n,'language',{configurable:true,get:function(){"
            + "return lang;}});"
            + "Object.defineProperty(n,'languages',{configurable:true,get:function(){"
            // 配置语言排最前,浏览器原有链条保留在后面作为回落。
            + "var rest=Array.prototype.slice.call(realList||[]).filter(function(x){"
            + "return x!==lang;});return [lang].concat(rest);}});"
            + "}catch(e){}})();";
    }
}
