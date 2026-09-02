package com.termux.paseo;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import org.junit.Test;

/**
 * 这些用例钉住的是「换个写法就静默失效」的那几处,不是字符串长相。
 * 每一条都对应 {@link PaseoTouchShim} 注释里记的一个实测结论。
 */
public class PaseoTouchShimTest {

    private static final String SCRIPT = PaseoTouchShim.injectionScript();

    /** 必须派发 mouseout:React 的 onMouseLeave 是从冒泡的 mouseout 反推出来的。 */
    @Test
    public void dispatchesMouseOutRatherThanMouseLeave() {
        assertTrue("必须派发 mouseout", SCRIPT.contains("'mouseout'"));
        assertFalse("派发 mouseleave 到不了 React 的根监听器,等于没派发",
            SCRIPT.contains("'mouseleave'"));
    }

    /** 不冒泡就到不了 React 挂在根容器上的那一个监听器。 */
    @Test
    public void theSyntheticEventBubbles() {
        assertTrue(SCRIPT.contains("bubbles:true"));
    }

    /**
     * relatedTarget 必须是这次点到的节点。写成 document.body 会把最近公共祖先抬到 html,
     * 于是点面板自己的开关也会把面板关掉。
     */
    @Test
    public void relatedTargetIsTheTapTargetNotTheBody() {
        assertTrue("relatedTarget 必须带上", SCRIPT.contains("relatedTarget:to"));
        assertFalse("relatedTarget 写成 body 会误关自己", SCRIPT.contains("relatedTarget:d.body"));
        assertFalse(SCRIPT.contains("relatedTarget:document.body"));
    }

    /** 有鼠标时浏览器本来就会发 mouseout,再补一发就是重复事件。 */
    @Test
    public void onlyActsOnTouchPointers() {
        assertTrue(SCRIPT.contains("pointerType!=='touch'"));
    }

    /** 点在同一个浮层内部(比如它自己的开关)时不能补 leave,否则一点就关。 */
    @Test
    public void skipsWhenTheTapLandsInsideTheHoveredSubtree() {
        assertTrue(SCRIPT.contains("prev.contains(to)"));
    }

    /** 页面可能在冒泡途中 stopPropagation,捕获阶段才保证看得到这次触摸。 */
    @Test
    public void listensInTheCapturePhase() {
        int listeners = 0;
        int from = 0;
        while ((from = SCRIPT.indexOf("addEventListener", from)) >= 0) {
            listeners += 1;
            from += 1;
        }
        assertTrue("应同时监听 mouseover 与 pointerdown", listeners >= 2);
        assertFalse("两个监听器都必须是捕获阶段", SCRIPT.contains("},false);"));
        assertTrue(SCRIPT.contains("},true);"));
    }

    /** 重复注入必须直接返回,否则每次 onPageFinished 都会再挂一对监听器。 */
    @Test
    public void installationIsIdempotent() {
        assertTrue(SCRIPT.contains("if(w." + PaseoTouchShim.FLAG + ")return;"));
        assertTrue(SCRIPT.contains("w." + PaseoTouchShim.FLAG + "=true;"));
    }

    /** 整段要能塞进 evaluateJavascript 的单行参数,且不得带会被 Java 字符串吃掉的反斜杠。 */
    @Test
    public void scriptIsSingleLineAndEscapeFree() {
        assertFalse(SCRIPT.contains("\n"));
        assertFalse(SCRIPT.contains("\r"));
        assertFalse(SCRIPT.contains("\\"));
    }

    /** 派发失败不能把这次触摸连带炸掉 —— 浮层关不掉比整页无响应好得多。 */
    @Test
    public void dispatchFailureIsContained() {
        assertTrue(SCRIPT.contains("try{"));
        assertTrue(SCRIPT.contains("catch(err){}"));
    }

    /** 光有类没接上等于没修:Activity 必须在每次 onPageFinished 注入。 */
    @Test
    public void activityInstallsTheShimOnEveryPageFinish() throws Exception {
        Path source = Paths.get("src/main/java/com/termux/paseo/PaseoActivity.java");
        String text = new String(Files.readAllBytes(source), StandardCharsets.UTF_8);
        assertTrue(text.contains("onPageFinished"));
        assertTrue(text.contains("PaseoTouchShim.injectionScript()"));
    }
}
