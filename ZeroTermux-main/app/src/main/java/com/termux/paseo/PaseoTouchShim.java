package com.termux.paseo;

/**
 * 把「鼠标移开」这一动作补回触屏,让 hover 驱动的浮层能被点掉。
 *
 * <p>EAC 运行时的插件普遍用桌面惯例写浮层:{@code onMouseEnter} 开、{@code onMouseLeave} 关。
 * 提示词优化插件({@code dsh-webui-prompt-optimizer})就是这样,面板可见性是
 * {@code panelVisible = hovered || phase !== "idle"},而 {@code hovered} 只由这两个回调翻转。
 * 触屏上点一下会合成 {@code mouseenter} 把它打开,却没有任何手势能产生对应的
 * {@code mouseleave} —— 于是那张选项卡片(多轮优化 / 设定目标提示词 / 使用 AI 浏览器验证)
 * 一旦打开就关不掉,还挡住输入框。真机实测:点图标 → 打开;点别处 → 仍然开着。
 *
 * <p>补法不是去认识某个插件,而是把鼠标本来会做的事做完整:记住上一个被 hover 的节点,
 * 下一次触摸落在它外面时,给它补一个 {@code mouseout}。三个细节是这条补丁能用的关键:
 *
 * <ul>
 *   <li>必须是 <b>{@code mouseout} 且 bubbles</b>。React 的 EnterLeaveEventPlugin 是从冒泡的
 *       {@code mouseout} + {@code relatedTarget} 反推 {@code onMouseLeave} 的;直接派发不冒泡的
 *       {@code mouseleave} 永远到不了 React 挂在根容器上的那一个监听器,等于没派发。</li>
 *   <li>{@code relatedTarget} 必须是<b>这次点到的节点</b>,不能图省事写 {@code document.body}。
 *       React 只对「from 到 from/to 最近公共祖先之间」的节点触发 leave:点面板里的开关时,
 *       公共祖先就是面板本身,面板的 {@code onMouseLeave} 因此不会被误触发。若把
 *       {@code relatedTarget} 写成 body,公共祖先升到 {@code html},点自己的开关也会把面板关掉。</li>
 *   <li>只在 {@code pointerType === 'touch'} 时补。接了鼠标的场景浏览器本来就会发
 *       {@code mouseout},再补一发就是重复事件。</li>
 * </ul>
 *
 * <p>这条补丁只<b>增加</b>鼠标本该产生的 leave,不拦截任何事件,所以不会把浮层锁死 ——
 * 关掉之后再点图标,{@code mouseenter} 照常把它打开(真机实测可反复开合)。
 */
final class PaseoTouchShim {

    /** 幂等标记;挂在 window 上,重复注入直接返回。 */
    static final String FLAG = "__paseoTouchShim";

    private PaseoTouchShim() {
    }

    /**
     * 返回安装补丁的一行 JS。两个监听器都用<b>捕获</b>阶段:页面自己可能在冒泡途中
     * {@code stopPropagation},捕获阶段才保证我们一定看得到这次触摸。
     */
    static String injectionScript() {
        return "(function(){var w=window,d=document;"
            + "if(w." + FLAG + ")return;w." + FLAG + "=true;"
            + "var from=null;"
            + "d.addEventListener('mouseover',function(e){from=e.target;},true);"
            + "d.addEventListener('pointerdown',function(e){"
            + "if(e.pointerType!=='touch')return;"
            + "var to=e.target;var prev=from;from=to;"
            + "if(!prev||!to||prev===to)return;"
            + "if(prev.contains&&prev.contains(to))return;"
            + "if(prev.isConnected===false)return;"
            + "try{prev.dispatchEvent(new MouseEvent('mouseout',"
            + "{bubbles:true,cancelable:true,relatedTarget:to}));}catch(err){}"
            + "},true);})();";
    }
}
