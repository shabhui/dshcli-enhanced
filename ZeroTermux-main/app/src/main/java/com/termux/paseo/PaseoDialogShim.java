package com.termux.paseo;

/**
 * EAC 的「优化提示词」面板在触屏上关不掉 —— 点外部、返回键都无效,只能等红色提示自己消失。
 *
 * <p>面板来自第三方插件 {@code dsh-webui-prompt-optimizer},它是个 <b>hover 悬浮面板</b>:
 * 可见性等于 {@code hovered || phase !== "idle"},只挂了 {@code onMouseEnter}/{@code onMouseLeave},
 * 没有点击开关。桌面端鼠标移开就收起,触屏上 WebView 把 tap 合成成 mouseenter 让 {@code hovered}
 * 变 true,但手指抬起不产生 mouseleave,于是 {@code hovered} 永远是 true。
 *
 * <p>校验失败时插件走 {@code finish("error", …)},把 {@code phase} 设为 {@code error} 并挂一个
 * 3800ms 的复位定时器 —— 这段时间里 {@code phase !== "idle"} 恒真,任何 hover 操作都压不住面板,
 * 所以用户只能等。
 *
 * <p>因此关闭要分两步:派发 React 认得的 {@code mouseout} 让插件自己把 {@code hovered} 置 false
 * (走它的 {@code scheduleHide}),再对 {@code done}/{@code error} 的残留做 class 级兜底。
 * 直接摘 class 是绕过 React 改 DOM,{@code hovered} 不变,下次重渲染又会加回来。
 *
 * <p>{@code optimizing} 期间不介入 —— 那时面板显示的是实时进度,关掉它用户就失去反馈了
 * (设备上确认过这个误伤:点外部后进度文案消失,后台任务其实还在跑)。
 *
 * <p>自带幂等标记,重复注入无副作用。
 */
final class PaseoDialogShim {
    private PaseoDialogShim() {}

    /** 插件根节点。hover 事件要派发到这里,面板与触发按钮都在其内。 */
    private static final String ROOT_CLASS = "webui-po-root";

    /** 面板本体,以及可见态附加的 class。真机确认:可见时 opacity:1/visible,否则 opacity:0/hidden。 */
    private static final String PANEL_CLASS = "webui-po-panel";
    private static final String PANEL_OPEN_CLASS = "webui-po-panel-open";

    /**
     * 插件把 {@code phase} 映射成状态区的 class。{@code optimizing} 时面板在显示实时进度
     * (「正在调用模型…」/「已生成 N 字」),摘掉它等于让用户失去反馈,所以兜底只针对
     * {@code done}/{@code error} —— 这两个是挂了复位定时器、hover 压不住的卡死态。
     */
    private static final String STATUS_DONE_CLASS = "webui-po-status-done";
    private static final String STATUS_ERROR_CLASS = "webui-po-status-error";
    private static final String STATUS_OPTIMIZING_CLASS = "webui-po-status-optimizing";

    /**
     * React 走 {@code mouseover}/{@code mouseout} 委托来模拟不冒泡的 enter/leave,
     * 直接派发 {@code mouseleave} 它收不到 —— 设备上验证过,只有这一对有效。
     */
    static String injectionScript() {
        return "(function(){"
            + "if(window.__paseoDialogShimInstalled)return;"
            + "window.__paseoDialogShimInstalled=true;"
            + "var ROOT='" + ROOT_CLASS + "';"
            + "var PANEL='" + PANEL_CLASS + "';"
            + "var OPEN='" + PANEL_OPEN_CLASS + "';"
            + "var DONE='" + STATUS_DONE_CLASS + "';"
            + "var ERR='" + STATUS_ERROR_CLASS + "';"
            + "var BUSY='" + STATUS_OPTIMIZING_CLASS + "';"
            // 当前可见的面板;不可见就返回 null。
            + "function visiblePanel(){"
            + "return document.querySelector('.'+OPEN);"
            + "}"
            // 第一步:让插件自己收起。mouseout 带 relatedTarget 才有 leave 语义。
            + "function leave(){"
            + "var root=document.querySelector('.'+ROOT);"
            + "if(!root)return;"
            + "root.dispatchEvent(new MouseEvent('mouseout',"
            + "{bubbles:true,cancelable:true,view:window,relatedTarget:document.body}));"
            + "}"
            // 进度态(optimizing)面板在显示实时进度,摘 class 会让用户失去反馈 —— 设备上
            // 确认过误伤:点外部后「正在调用模型…」直接消失,而后台任务其实还在跑。
            // 只有 done/error 才是挂了复位定时器、hover 压不住的卡死态,兜底只管这两个。
            + "function pinnedByPhase(){"
            + "return !!document.querySelector('.'+DONE+',.'+ERR);"
            + "}"
            // optimizing 正在跑,面板是进度显示,任何关闭动作都不该介入。
            + "function busy(){"
            + "return !!document.querySelector('.'+BUSY);"
            + "}"
            // 第二步:phase 卡在 done/error 时 hover 压不住,兜底摘 class。插件下次重渲染会
            // 自行收敛,因为那时 phase 已复位、hovered 也被上一步置 false 了。
            + "function forceHide(){"
            + "var list=document.querySelectorAll('.'+OPEN);"
            + "for(var i=0;i<list.length;i++){"
            + "list[i].classList.remove(OPEN);"
            + "}"
            + "}"
            + "function dismiss(){"
            + "leave();"
            // 留一帧给 React 的 scheduleHide(80ms 定时器)走完。还在且 phase 卡在 done/error
            // 才兜底;optimizing 期间保持面板,让进度继续可见。
            + "window.setTimeout(function(){"
            + "if(visiblePanel()&&pinnedByPhase())forceHide();"
            + "},120);"
            + "}"
            // 捕获阶段监听:插件在冒泡阶段 stopPropagation 也拦不住我们。
            + "document.addEventListener('pointerdown',function(e){"
            + "if(!visiblePanel())return;"
            + "if(busy())return;"
            // 点在插件自己范围内(面板或触发按钮)不干预 —— 那是正常交互。
            + "var root=document.querySelector('.'+ROOT);"
            + "if(root&&root.contains(e.target))return;"
            + "var panel=document.querySelector('.'+PANEL);"
            + "if(panel&&panel.contains(e.target))return;"
            + "dismiss();"
            + "},true);"
            // 返回键/ESC 也应该能关,和点外部一致。
            + "document.addEventListener('keydown',function(e){"
            + "if(e.key!=='Escape')return;"
            + "if(visiblePanel()&&!busy())dismiss();"
            + "},true);"
            + "})();";
    }
}
