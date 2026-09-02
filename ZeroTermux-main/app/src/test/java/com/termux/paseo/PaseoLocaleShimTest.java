package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * 插件市场整页英文不是因为缺翻译 —— {@code dsh-unified-market} 自带完整中文表,
 * 但它按 {@code navigator.language} 选分支,而那跟随应用语言,不是 EAC 的界面语言设置。
 * 权威源是 EAC 自己写的 {@code ~/.dsh/settings.yaml}(详见 PaseoLocaleShim 类注释)。
 *
 * <p>这些用例钉住两件事:解析必须限定在 {@code locale:} 块内,以及<b>信息不足时不要覆盖</b> ——
 * 猜错语言会把英文用户的界面也改坏。
 */
public class PaseoLocaleShimTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private File homeWithSettings(String yaml) throws Exception {
        File home = folder.newFolder("home");
        File dsh = new File(home, ".dsh");
        assertTrue(dsh.mkdirs());
        Files.write(new File(dsh, "settings.yaml").toPath(), yaml.getBytes(StandardCharsets.UTF_8));
        return home;
    }

    @Test
    public void readsThePreferenceEacActuallyWrites() throws Exception {
        // 真机上 settings.yaml 的实际内容(节选),包含 locale 之外的块。
        File home = homeWithSettings(
            "ui-onboarding:\n"
                + "  welcomeNoticeVersion: 2026-08-13.1\n"
                + "locale:\n"
                + "  preference: zh\n"
                + "agent-default-model:\n"
                + "  provider: kapi\n");

        assertEquals("zh", PaseoLocaleShim.preferredLanguage(home));
    }

    @Test
    public void onlyAcceptsPreferenceInsideTheLocaleBlock() {
        // 别的块也可能有 preference:,拿错就会把界面语言设成无关的值。
        assertNull(PaseoLocaleShim.parsePreference(
            "sort:\n  preference: newest\nui:\n  preference: compact\n"));
        assertEquals("en", PaseoLocaleShim.parsePreference(
            "sort:\n  preference: newest\nlocale:\n  preference: en\n"));
    }

    @Test
    public void leavesTheBrowserAloneWhenTheSettingMeansFollowSystem() {
        // auto/system 的意思正是「用浏览器的」,这时覆盖就是错的。
        assertNull(PaseoLocaleShim.parsePreference("locale:\n  preference: auto\n"));
        assertNull(PaseoLocaleShim.parsePreference("locale:\n  preference: system\n"));
        assertNull(PaseoLocaleShim.parsePreference("locale:\n  preference: default\n"));
    }

    @Test
    public void returnsNullRatherThanGuessingWhenTheSettingIsAbsent() throws Exception {
        assertNull("没有 locale 块",
            PaseoLocaleShim.parsePreference("ui-onboarding:\n  welcomeNoticeVersion: 1\n"));
        assertNull("空值", PaseoLocaleShim.parsePreference("locale:\n  preference:\n"));
        assertNull("locale 块里没有 preference",
            PaseoLocaleShim.parsePreference("locale:\n  fallback: zh\n"));
        assertNull("文件不存在", PaseoLocaleShim.preferredLanguage(folder.newFolder("empty")));
        assertNull("home 为 null", PaseoLocaleShim.preferredLanguage(null));
    }

    @Test
    public void rejectsValuesThatAreNotLanguageTags() {
        // 值会被放进单引号 JS 字符串,所以带引号/反斜杠的必须挡在外面。
        assertNull(PaseoLocaleShim.parsePreference("locale:\n  preference: zh'+alert(1)+'\n"));
        assertNull(PaseoLocaleShim.parsePreference("locale:\n  preference: 中文\n"));
        assertNull(PaseoLocaleShim.parsePreference("locale:\n  preference: x\n"));
        assertEquals("引号包裹的合法值要能取出", "zh-CN",
            PaseoLocaleShim.parsePreference("locale:\n  preference: \"zh-CN\"\n"));
    }

    @Test
    public void ignoresComments() {
        assertEquals("zh", PaseoLocaleShim.parsePreference(
            "locale:  # 界面语言\n  preference: zh  # 中文\n"));
        assertNull(PaseoLocaleShim.parsePreference("locale:\n  preference: zh\n".replace(
            "  preference: zh", "  # preference: zh")));
    }

    @Test
    public void injectsNothingWhenThereIsNoTrustworthyLanguage() {
        // 空串意味着「无事可做」,调用方据此跳过注入。
        assertEquals("", PaseoLocaleShim.injectionScript(null));
        assertEquals("", PaseoLocaleShim.injectionScript(""));
        assertEquals("", PaseoLocaleShim.injectionScript("zh'+alert(1)+'"));
    }

    @Test
    public void overridesBothPropertiesOnTheInstance() {
        String script = PaseoLocaleShim.injectionScript("zh");

        // 两个属性都在 Navigator.prototype 上且只有 getter,只能在实例上覆盖。
        assertTrue(script.contains("Object.defineProperty(n,'language'"));
        assertTrue(script.contains("Object.defineProperty(n,'languages'"));
        assertTrue("必须可配置,否则重复注入会抛", script.contains("configurable:true"));
        assertTrue("必须带上配置里的语言", script.contains("var lang='zh';"));
    }

    @Test
    public void putsTheConfiguredTagFirstAndKeepsTheRestAsFallback() {
        String script = PaseoLocaleShim.injectionScript("zh");

        assertTrue(script.contains("[lang].concat(rest)"));
        assertTrue("不能重复出现同一个标签", script.contains("return x!==lang"));
    }

    @Test
    public void isIdempotentSoRepeatInjectionIsSafe() {
        String script = PaseoLocaleShim.injectionScript("zh");

        assertTrue(script.contains(PaseoLocaleShim.FLAG));
        assertTrue(script.contains("if(w." + PaseoLocaleShim.FLAG + ")return"));
    }

    @Test
    public void isASingleLineAndSurvivesEvaluateJavascript() {
        String script = PaseoLocaleShim.injectionScript("zh-CN");

        assertEquals("必须单行", -1, script.indexOf('\n'));
        assertFalse("不能含双引号", script.contains("\""));
        assertFalse("不能含反斜杠", script.contains("\\"));
    }

    @Test
    public void containsItsOwnFailuresSoAPageIsNeverBrokenByTheShim() {
        String script = PaseoLocaleShim.injectionScript("zh");

        assertTrue(script.contains("try{"));
        assertTrue(script.contains("}catch(e){}"));
    }

    @Test
    public void activityInstallsTheShimBeforeThePageScriptsRun() throws Exception {
        String activity = new String(
            Files.readAllBytes(
                new File("src/main/java/com/termux/paseo/PaseoActivity.java").toPath()),
            StandardCharsets.UTF_8);

        // 插件的 LOCALE 是模块级常量,实测在 2ms 就读完了。真机验证过:
        // onPageFinished 之后再改无效(市场重挂载 2821 行,字符串仍是英文)。
        assertTrue("必须重写 onPageStarted", activity.contains("onPageStarted"));
        assertTrue(activity.contains("PaseoLocaleShim"));

        int started = activity.indexOf("onPageStarted");
        int shim = activity.indexOf("PaseoLocaleShim.injectionScript(");
        int finished = activity.indexOf("onPageFinished");
        assertTrue("locale shim 必须出现在 onPageStarted 里", shim > started);
        assertTrue("onPageStarted 必须排在 onPageFinished 之前", started < finished);
    }
}
