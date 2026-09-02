package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 412px 上 EAC 设置页坏掉,是两个第三方插件断点重叠打架的结果(详见 PaseoMobileCss 的类注释):
 * mobile-fix 把导航翻成横向条,meow 把标签折叠成 0 宽,叠加后就是一排 21 个相同齿轮,
 * 且 meow 会吞掉折叠态的第一次点击。加上 mobile-fix 漏了 min-width,面板还宽于视口够不到。
 *
 * <p>这些用例把每一条修正钉住 —— 任意一条丢失,真机上的设置页都会退回"看不懂 + 点不到"。
 * 断言全部对应真机上用 CDP 量到的值。
 */
public class PaseoMobileCssTest {

    @Test
    public void cssNeedsNoEscapingSoItCanBeEmbeddedInASingleQuotedScript() {
        String css = PaseoMobileCss.css();

        // 注入脚本把 CSS 放进单引号字符串;org.json 不是测试依赖,所以这里不能用
        // JSONObject.quote 兜底。CSS 属性选择器的值只要是合法标识符就无需引号,
        // 因此保持整段 CSS 无引号、无反斜杠、无换行。
        assertFalse("CSS 不能包含单引号", css.contains("'"));
        assertFalse("CSS 不能包含双引号", css.contains("\""));
        assertFalse("CSS 不能包含反斜杠", css.contains("\\"));
        assertFalse("CSS 不能包含换行", css.contains("\n"));
    }

    @Test
    public void overridesTheMinWidthThatKeepsThePanelWiderThanTheViewport() {
        String css = PaseoMobileCss.css();

        assertTrue("必须命中插件自己的对话框选择器",
            css.contains("[role=dialog][aria-modal=true][aria-labelledby]"));
        // mobile-fix 写了 width/max-width:100vw 却没覆盖 module 的 min-width:640px,
        // 而 CSS 里 min-width 胜过 max-width —— 少了这条,面板就还是 640px。
        assertTrue("必须把 min-width 压到 0", css.contains("min-width:0 !important"));
    }

    @Test
    public void keepsTheBreakpointAlignedWithTheMobileFixPlugin() {
        String css = PaseoMobileCss.css();

        // 插件的问题规则在 (max-width:700px) 里。断点不一致就会留出一段区间:
        // 插件的坏规则生效,我们的修正却不生效。
        assertTrue(css.contains("@media (max-width:700px)"));
    }

    @Test
    public void raisesSpecificityAboveBothPluginsSoInjectionOrderDoesNotMatter() {
        String css = PaseoMobileCss.css();

        // 两个插件的规则都带 !important(mobile-fix 的选择器特异度 0-3-2)。同为
        // !important 时特异度决胜,而页面上有 130+ 个样式表、顺序不由我们决定,
        // 所以必须靠特异度:附加 [class] 把每条抬上去。
        assertTrue(css.contains("[aria-labelledby][class]"));
        assertTrue("同为 important 才谈特异度", css.contains("!important"));
    }

    @Test
    public void restoresTheMeowRailInsteadOfFightingItsClickHandler() {
        String css = PaseoMobileCss.css();

        // meow 折叠态会吞掉导航区的点击(preventDefault)只为切到展开态。顺着它的设计
        // 把竖向轨道还回去,第一次点击才有可见反馈(轨道变宽、标签出现)。
        assertTrue("必须按 meow 的状态标记分支", css.contains("[data-meow-smooth-settings=collapsed]"));
        assertTrue(css.contains("[data-meow-smooth-settings=expanded]"));
        assertTrue("折叠态轨道 56px", css.contains("width:56px !important"));
        assertTrue("展开态轨道 188px", css.contains("width:188px !important"));
        // mobile-fix 把对话框改成 column、把 nav 拉成 100%,两条都要翻回来,
        // 否则拿到的是 meow 的折叠标签塞进 mobile-fix 的横向条。
        assertTrue("对话框要回到 row", css.contains("flex-direction:row !important"));
        assertTrue("导航要回到 column", css.contains("flex-direction:column !important"));
    }

    @Test
    public void expandedLabelsNeedMaxWidthNotJustWidth() {
        String css = PaseoMobileCss.css();

        // meow 折叠标签用的是 max-width:0 —— 只改 width 的话标签仍然是 0 宽。
        // 这一条正是第一次尝试失败的原因,真机上量到 spanW=0 而 width 已是 auto。
        assertTrue(css.contains("max-width:200px !important"));
        assertTrue(css.contains("opacity:1 !important"));
    }

    @Test
    public void stillFixesTheStripWhenMeowIsNotInstalled() {
        String css = PaseoMobileCss.css();

        // 只装 mobile-fix 时,横向条没有滚动容器,两端被裁掉且够不到;
        // 标签也仍被 flex:1 1 0 + overflow:hidden 压成 0 宽。
        assertTrue("要能区分未装 meow 的情况", css.contains(":not([data-meow-smooth-settings])"));
        assertTrue("横向条要能滚动", css.contains("overflow-x:auto !important"));
        assertTrue("按钮按内容取宽", css.contains("flex:0 0 auto !important"));
        assertTrue("标签不能再被裁", css.contains("overflow:visible !important"));
    }

    @Test
    public void skipsRenderingWorkForOffScreenMarketRows() {
        String css = PaseoMobileCss.css();

        // 市场一次铺 2777 行、整页 37076 个节点,任何一次布局失效都要走完整棵树:
        // 真机实测强制布局中位数 290ms。跳过视口外行后降到 52ms。
        assertTrue("必须命中市场的行", css.contains(".mkts-item"));
        assertTrue(css.contains("content-visibility:auto"));
        // hidden 会让内容退出页内搜索与焦点顺序,auto 不会 —— 这里只能是 auto。
        assertFalse("不能用 hidden,那会破坏页内搜索与焦点",
            css.contains("content-visibility:hidden"));
    }

    @Test
    public void remembersRealRowHeightSoTheScrollbarDoesNotJump() {
        String css = PaseoMobileCss.css();

        // 少了占位高度,被跳过的行高就是 0,滚动条长度会瞎跳;
        // 少了 auto 关键字则永远用占位值,渲染过的真实高度不会被记住。
        assertTrue("要给被跳过的行占位高度", css.contains("contain-intrinsic-size:auto 122px"));
    }

    @Test
    public void appliesTheMarketFixAtEveryWidthNotJustNarrowScreens() {
        String css = PaseoMobileCss.css();

        // 节点太多与屏幕宽度无关,平板/横屏一样卡。这条若被裹进 (max-width:700px),
        // 宽屏就白白退回 290ms。
        assertFalse("市场修正不能被裹进窄屏媒体查询",
            insideNarrowMediaQuery(css).contains(".mkts-item"));
    }

    @Test
    public void pullsTheSideSessionPanelBackOnScreenOnNarrowViewports() {
        String css = PaseoMobileCss.css();

        // dsh-side-session 的悬浮面板写死了桌面端的 right:80px,同时用 max-width:92vw 限宽。
        // 412px 视口上两条一起生效:412 - 80 - 379.2 = -47.2px,左边缘出屏 —— 真机实测
        // left:-48.5px,标题「会话」只剩右半边。改成右侧贴边,宽度限制保持插件自己的。
        assertTrue("要覆盖 dsh-side-session 的悬浮面板", css.contains(".dss-float"));
        assertTrue("桌面端的 80px 右边距在窄屏上必须归零", css.contains("right:0 !important"));
        assertTrue("只压右边距不够,left:auto 才能让 max-width 从右往左量",
            css.contains("left:auto !important"));
    }

    @Test
    public void keepsTheSideSessionFixOnlyOnNarrowScreens() {
        String css = PaseoMobileCss.css();

        // 溢出只在窄屏发生;宽屏上 80px 是插件有意留的边距,抹掉它是无谓的改动。
        assertTrue("这条必须待在窄屏媒体查询里",
            insideNarrowMediaQuery(css).contains(".dss-float"));
    }

    @Test
    public void clearsTheExplorerTabBarOfTheMeowFloatingButton() {
        String css = PaseoMobileCss.css();

        // meow 收起态的 FAB 是 fixed、z-index:9997、56×56、不透明底色;文件浏览器的整屏抽屉
        // z-index 只有 50,于是标签栏左端 56×35px 被盖住,「Explorer」真机上显示成「…orer」。
        assertTrue("要命中文件浏览器的标签栏", css.contains(".dxPSYW_tabBar"));
        assertTrue("让出的宽度必须等于 FAB 的 56px", css.contains("padding-left:56px !important"));
        // 标签栏自带边框与固定高度,不改 box-sizing 的话这 56px 会把它撑宽,引入横向溢出。
        assertTrue(css.contains("box-sizing:border-box !important"));
    }

    @Test
    public void onlyYieldsSpaceWhileTheFloatingButtonIsActuallyThere() {
        String css = PaseoMobileCss.css();

        // FAB 只在 meow 侧栏收起时出现。无条件留 56px 会在侧栏展开时凭空多出一块空白。
        assertTrue("必须挂在 meow 的收起标记上",
            css.contains("html[data-meow-smooth-furled] .dxPSYW_tabBar"));
    }

    @Test
    public void doesNotHideTheFloatingButtonToFreeTheTabBar() {
        String css = PaseoMobileCss.css();

        // 抽屉收起时是 transform 移出视口 + visibility:hidden,元素一直留在 DOM 里
        // (真机实测 drawerInDom:true),所以 body:has(抽屉) 会永久命中 ——
        // 藏 FAB 等于永久拿掉 meow 侧栏的唯一入口。让位是唯一不破坏功能的做法。
        assertFalse("不能靠 :has() 判断抽屉在不在", css.contains(":has("));
        assertFalse("不能藏掉 FAB", css.contains("data-meow-smooth-fab"));
    }

    @Test
    public void keepsTheTabBarFixOnlyOnNarrowScreens() {
        String css = PaseoMobileCss.css();

        // 宽屏上抽屉不整屏铺开,FAB 与标签栏不重叠;那里留 56px 只是白占地方。
        assertTrue("这条必须待在窄屏媒体查询里",
            insideNarrowMediaQuery(css).contains(".dxPSYW_tabBar"));
    }

    /** 截出 {@code @media (max-width:700px)} 块的内容,用于判断某条规则在不在窄屏分支里。 */
    private static String insideNarrowMediaQuery(String css) {
        int mediaStart = css.indexOf("@media (max-width:700px){");
        assertTrue("找不到媒体查询,断言就没有意义", mediaStart >= 0);

        int depth = 0;
        for (int i = css.indexOf('{', mediaStart); i < css.length(); i++) {
            char c = css.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) {
                    return css.substring(mediaStart, i);
                }
            }
        }
        throw new AssertionError("媒体查询的括号必须闭合");
    }

    @Test
    public void activityInjectsTheStylesheetOnEveryPageFinish() throws Exception {
        String activity = new String(
            java.nio.file.Files.readAllBytes(
                new java.io.File("src/main/java/com/termux/paseo/PaseoActivity.java").toPath()),
            java.nio.charset.StandardCharsets.UTF_8);

        // 样式本身正确但没接上去,等于没修 —— 这条把接线钉住。
        assertTrue("必须在 onPageFinished 里注入", activity.contains("onPageFinished"));
        assertTrue(activity.contains("PaseoMobileCss.injectionScript()"));
    }

    @Test
    public void injectionScriptIsIdempotentAndCarriesTheCss() {
        String script = PaseoMobileCss.injectionScript();

        assertTrue("靠固定 id 复用同一个 style 节点,重复注入不叠加",
            script.contains(PaseoMobileCss.STYLE_ID));
        assertTrue(script.contains("getElementById"));
        assertTrue(script.contains(PaseoMobileCss.css()));
        assertEquals("脚本必须是单行,evaluateJavascript 才安全", -1, script.indexOf('\n'));
    }
}
