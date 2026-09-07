package com.termux.paseo;

/**
 * 注入到 EAC Web UI 的窄屏修正样式,只管设置面板。
 *
 * <p>EAC 自己的设置面板是桌面布局(188px 竖向侧栏)。运行时装了两个第三方插件,它们都想改窄屏
 * 设置页,断点还重叠,于是在 412px 的手机上互相打架:
 *
 * <ul>
 *   <li>{@code dsh-web-mobile-fix@1.0.1}(≤700px)把导航翻成<b>横向</b>一行,并给每个按钮
 *       {@code flex:1 1 0} —— 24 个标签页平分 616px,每个只剩 20px。</li>
 *   <li>{@code meow-smooth@0.5.0}(≤1023px)把导航做成<b>竖向可展开轨道</b>:
 *       {@code collapsed} 时 56px、标签 {@code max-width:0},{@code expanded} 时 188px、
 *       标签 {@code max-width:200px}。</li>
 * </ul>
 *
 * <p>两者叠加的结果是最坏组合:mobile-fix 的 {@code width:100% !important} 压过 meow 未加
 * {@code !important} 的 {@code 56px},于是拿到 meow 的<b>折叠标签</b>塞进 mobile-fix 的
 * <b>横向条</b> —— 一排 21 个完全相同的齿轮圆点(24 项里 21 项共用同一个图标),没有文字可辨认。
 * 更糟的是 meow 的点击拦截:{@code collapsed} 时点导航区会被 {@code preventDefault} 吞掉,
 * 只用来切到 {@code expanded} 而不选中页面,而横向条上"展开"几乎看不出变化,于是第一次点击像是没反应。
 *
 * <p>另外 mobile-fix 给对话框写了 {@code width/max-width:100vw} 却没覆盖 CSS module 的
 * {@code min-width:640px} —— CSS 里 min-width 胜过 max-width,面板因此仍是 640px,被
 * {@code justify-content:center} 的 overlay 左右各裁掉 114px,而 overlay 是
 * {@code overflow-x:visible},裁掉的部分根本够不到。
 *
 * <p>所以修正分三块:min-width 无条件压到 0;<b>装了 meow 就把它的竖向轨道还回去</b>
 * (顺着它的交互设计,而不是和它的 JS 对抗);<b>没装 meow 则把 mobile-fix 的横向条变成真正的
 * 滚动条</b>并让按钮按内容取宽。选择器沿用两个插件自己的结构式写法并追加 {@code [class]},
 * 把特异度抬到它们之上 —— 双方都带 {@code !important} 时特异度决胜,页面上有 130+ 个样式表且
 * 顺序不由我们决定,靠顺序是不可靠的。
 *
 * <p><b>第二块:插件市场的长列表。</b>{@code dsh-unified-market} 一次把整个目录铺进 DOM,
 * 没有虚拟滚动 —— 真机实测 2777 条、每条约 13 个节点,整页 37076 个节点(对比空闲会话页 569 个)。
 * 于是任何一次布局失效都要走这棵树:实测强制布局中位数 <b>290ms</b>(最坏 394ms),这就是
 * 「设置卡」「插件安装卸载非常卡」的来源 —— 而且市场列表就挂在设置面板的滚动列
 * ({@code QvjHPa_options})里,两个症状同一个根因。
 *
 * <p>节点数不是样式能改的,但渲染工作量可以:{@code content-visibility:auto} 让浏览器跳过
 * 视口外行的布局与绘制,{@code contain-intrinsic-size} 给被跳过的行一个占位高度,
 * 其中 {@code auto} 关键字会记住该行真实渲染过的高度,滚动条长度因此不会乱跳。
 * 同一台机器上实测降到中位数 <b>52ms</b>(最坏 75ms)。这条不放进窄屏媒体查询:节点太多是
 * 平台无关的问题,平板/横屏一样受益;{@code content-visibility:auto} 也不影响页内搜索与焦点,
 * 与 {@code hidden} 不同。
 *
 * <p><b>第三块:文件浏览器的标签栏被 meow 的悬浮按钮压住。</b>{@code meow-smooth} 在自己的侧栏
 * 收起时会放一个 {@code fixed} 的悬浮按钮(FAB)在左上角:56×56、{@code z-index:9997}、
 * 不透明底色。而文件浏览器的抽屉在窄屏上是整屏铺开的 {@code fixed} 面板,
 * {@code z-index} 只有 50 —— 于是 FAB 正好盖住标签栏左端 56×35px 的一块,
 * 「Explorer」的前 46px 被吃掉,真机上显示成「…orer」。
 *
 * <p>meow 显示 FAB 本身没错(它的侧栏确实收起了),冲突来自另一个插件:那个抽屉不是
 * {@code div[role=dialog]},漏在了 meow 自己的避让规则之外。所以修法是给标签栏让出 56px,
 * 而不是把 FAB 藏掉 —— 抽屉收起时是用 {@code transform} 移出视口加 {@code visibility:hidden},
 * 元素一直留在 DOM 里,{@code body:has(抽屉)} 会永久命中,FAB 就再也点不出来了
 * (真机实测收起后仍 {@code drawerInDom:true})。
 */
final class PaseoMobileCss {

    /** 注入节点的 id;固定值使重复注入落到同一个节点上,不会叠加。 */
    static final String STYLE_ID = "paseo-mobile-css";

    /**
     * 对话框选择器。末尾的 {@code [class]} 只为抬特异度 —— 面板始终带 CSS module 类名,
     * 所以它不会缩小匹配范围。
     */
    private static final String DIALOG =
        "[role=dialog][aria-modal=true][aria-labelledby][class]";

    /** meow 在面板上打的状态标记。 */
    private static final String MEOW_ATTR = "data-meow-smooth-settings";

    /** 插件市场的行,{@code dsh-unified-market} 自己的类名(不是 CSS module 哈希)。 */
    private static final String MARKET_ROW = ".mkts-item";

    /** {@code dsh-side-session} 的悬浮面板。 */
    private static final String SIDE_SESSION_PANEL = ".dss-float";

    /** 文件浏览器抽屉的标签栏,插件自己的类名。 */
    private static final String EXPLORER_TAB_BAR = ".dxPSYW_tabBar";

    /** meow 侧栏收起时打在 {@code <html>} 上的标记 —— 也正是 FAB 出现的条件。 */
    private static final String MEOW_FURLED_ATTR = "data-meow-smooth-furled";

    /** meow 的悬浮按钮尺寸,真机实测 56×56。标签栏要让出的就是这个宽度。 */
    private static final int MEOW_FAB_SIZE_PX = 56;

    /**
     * 被跳过的行的占位高度,真机实测单行 122px。只在该行还没真正渲染过时使用 ——
     * {@code contain-intrinsic-size} 的 {@code auto} 关键字会记住渲染过的实际高度。
     */
    private static final int MARKET_ROW_HEIGHT_PX = 122;

    private static final String WITH_MEOW = DIALOG + "[" + MEOW_ATTR + "]";
    private static final String NO_MEOW = DIALOG + ":not([" + MEOW_ATTR + "])";
    private static final String COLLAPSED = WITH_MEOW + "[" + MEOW_ATTR + "=collapsed]";
    private static final String EXPANDED = WITH_MEOW + "[" + MEOW_ATTR + "=expanded]";

    private PaseoMobileCss() {
    }

    /**
     * 返回样式表内容。整段刻意不含引号与反斜杠,{@link #injectionScript()} 才能直接把它
     * 放进单引号 JS 字符串;CSS 属性选择器的值只要是合法标识符就无需引号
     * ({@code [role=dialog]} 等价于 {@code [role="dialog"]})。
     */
    static String css() {
        StringBuilder css = new StringBuilder(1600);
        css.append("@media (max-width:700px){");

        // 0) 插件漏掉的那一条:面板宽于视口且够不到,根源就在这里。
        css.append(DIALOG).append("{min-width:0 !important;}");

        // 1) 装了 meow:把它的竖向轨道还回去。mobile-fix 把对话框改成 column、
        //    把 nav 拉成 100% 宽,这两条要按 meow 的原意翻回来。
        css.append(WITH_MEOW).append("{flex-direction:row !important;}");
        css.append(WITH_MEOW).append(">nav{")
            .append("flex-direction:column !important;box-sizing:border-box !important;}");
        css.append(WITH_MEOW).append(">nav>div{")
            .append("flex-flow:column !important;")
            .append("overflow-x:hidden !important;overflow-y:auto !important;}");
        css.append(WITH_MEOW).append(">nav>div>button{")
            .append("flex:0 0 auto !important;width:auto !important;}");

        css.append(COLLAPSED).append(">nav{width:56px !important;padding:22px 10px 0 !important;}");
        css.append(COLLAPSED).append(">nav>div>button{")
            .append("width:36px !important;justify-content:center !important;}");

        css.append(EXPANDED).append(">nav{width:188px !important;padding:22px 12px 0 !important;}");
        css.append(EXPANDED).append(">nav>div>button{justify-content:flex-start !important;}");
        // 展开态必须连 max-width 一起覆盖:mobile-fix 只动 width,而 meow 折叠时用的是
        // max-width:0,单改 width 的话标签仍然是 0 宽。
        css.append(EXPANDED).append(">nav>div>button>span{")
            .append("flex:1 1 0 !important;width:auto !important;")
            .append("max-width:200px !important;opacity:1 !important;}");

        // 2) 没装 meow:mobile-fix 的横向条本身没有滚动容器,两端都被裁掉且够不到。
        //    把它变成真正的滚动条,按钮按内容取宽,标签重新可见。
        css.append(NO_MEOW).append(">nav{")
            .append("width:100% !important;min-width:0 !important;box-sizing:border-box !important;}");
        css.append(NO_MEOW).append(">nav>div{")
            .append("flex-wrap:nowrap !important;")
            .append("overflow-x:auto !important;overflow-y:hidden !important;")
            .append("scrollbar-width:none !important;")
            .append("-webkit-overflow-scrolling:touch !important;}");
        css.append(NO_MEOW).append(">nav>div>button{")
            .append("flex:0 0 auto !important;width:auto !important;min-width:0 !important;")
            .append("justify-content:flex-start !important;}");
        css.append(NO_MEOW).append(">nav>div>button>span{")
            .append("flex:0 0 auto !important;width:auto !important;max-width:none !important;")
            .append("overflow:visible !important;text-overflow:clip !important;}");

        // 3) dsh-side-session 的悬浮面板:right:80px 是桌面端边距,配 max-width:92vw 用。
        //    412px 视口上 412 - 80 - 379.2 = -47.2px,左边缘出屏(真机 left:-48.5px,裁掉 49px)。
        //    贴到右边缘并让 left 自动,宽度仍由插件自己的 max-width 决定。
        css.append(SIDE_SESSION_PANEL)
            .append("{right:0 !important;left:auto !important;}");

        // 4) meow 收起态的 FAB(fixed, z=9997, 56×56, 不透明)盖住文件浏览器抽屉(z=50)的
        //    标签栏左端,「Explorer」被吃掉前 46px。只在 FAB 真的在场时让位,
        //    并且只让 padding —— 藏 FAB 会连带废掉 meow 的入口,见类注释。
        css.append("html[").append(MEOW_FURLED_ATTR).append("] ").append(EXPLORER_TAB_BAR)
            .append("{padding-left:").append(MEOW_FAB_SIZE_PX)
            .append("px !important;box-sizing:border-box !important;}");

        css.append("}");

        // 5) 插件市场:2777 行全在 DOM 里,任何一次布局失效都要走完整棵树。
        //    跳过视口外行的布局与绘制,实测强制布局 290ms -> 52ms。
        //    刻意放在媒体查询之外 —— 节点数与屏幕宽度无关。
        css.append(MARKET_ROW).append("{content-visibility:auto;")
            .append("contain-intrinsic-size:auto ").append(MARKET_ROW_HEIGHT_PX)
            .append("px;}");

        // Composer and long chat streams: skip layout/paint for off-screen bubbles.
        css.append("[data-testid=chat-message],[data-testid=assistant-message],")
            .append("[data-testid=user-message],.dss-session-item{")
            .append("content-visibility:auto;contain-intrinsic-size:auto 96px;}");
        css.append("textarea,[contenteditable=true]{scroll-margin-bottom:96px;}");
        css.append("[role=dialog],[role=alertdialog]{overscroll-behavior:contain;}");

        return css.toString();
    }

    /**
     * 返回把 {@link #css()} 塞进页面的一行 JS。按 id 复用节点,因此可以在每次
     * {@code onPageFinished} 时无条件调用 —— EAC Web UI 是 SPA,首屏加载后 React 不管这个
     * 节点,样式会一直生效。
     */
    static String injectionScript() {
        return "(function(){var d=document;if(!d.head)return;"
            + "var e=d.getElementById('" + STYLE_ID + "');"
            + "if(!e){e=d.createElement('style');e.id='" + STYLE_ID + "';d.head.appendChild(e);}"
            + "var c='" + css() + "';if(e.textContent!==c){e.textContent=c;}})();";
    }
}
