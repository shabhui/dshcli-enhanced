package com.termux.paseo;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Test;

public class PaseoDialogShimTest {

    @Test
    public void shimDismissesTheOptimizerPanelOnOutsidePointerDownInTheCapturePhase() {
        String script = PaseoDialogShim.injectionScript();

        // 插件在冒泡阶段 stopPropagation，捕获阶段(第三个参数 true)是唯一能先跑到的位置。
        assertTrue(script.contains("addEventListener('pointerdown'"));
        assertTrue(script.contains("},true);"));
        assertFalse(script.contains("addEventListener('click'"));

        // 点在插件自己范围内(面板或触发按钮)是正常交互，不能误关。
        assertTrue(script.contains("root.contains(e.target)"));
        assertTrue(script.contains("panel.contains(e.target)"));
    }

    @Test
    public void shimLetsReactCollapseThePanelViaItsMouseOutDelegation() {
        String script = PaseoDialogShim.injectionScript();

        // 面板可见性是 hovered || phase !== "idle"，只挂了 onMouseEnter/onMouseLeave。
        // React 用 mouseover/mouseout 委托模拟这两个不冒泡的事件，
        // 直接派发 mouseleave 它收不到 —— 设备上验证过只有这一对有效。
        assertTrue(script.contains("MouseEvent('mouseout'"));
        assertTrue(script.contains("relatedTarget:document.body"));
        assertFalse(script.contains("MouseEvent('mouseleave'"));

        // 事件要落在插件根节点上，面板与触发按钮都在其内。
        assertTrue(script.contains("webui-po-root"));
    }

    @Test
    public void shimForceHidesOnlyWhenPhaseKeepsThePanelPinned() {
        String script = PaseoDialogShim.injectionScript();

        // 校验失败走 finish("error", …)，phase 卡在 error 3800ms，期间 hover 压不住面板。
        // 所以先让插件自己收起，留一帧给它的 80ms scheduleHide，还在才兜底摘 class。
        assertTrue(script.contains("leave();"));
        assertTrue(script.contains("if(visiblePanel()&&pinnedByPhase())forceHide();"));
        assertTrue(script.contains("classList.remove(OPEN)"));
        assertTrue(script.contains("webui-po-panel-open"));

        // 兜底只认 done/error —— 这两个挂了复位定时器，hover 压不住。
        assertTrue(script.contains("webui-po-status-done"));
        assertTrue(script.contains("webui-po-status-error"));
    }

    @Test
    public void shimLeavesTheProgressPanelAloneWhileOptimizing() {
        String script = PaseoDialogShim.injectionScript();

        // optimizing 期间面板显示实时进度（「正在调用模型…」/「已生成 N 字」）。
        // 设备上确认过误伤：点外部后进度文案消失，而后台任务还在跑并把结果写回输入框。
        assertTrue(script.contains("webui-po-status-optimizing"));
        assertTrue(script.contains("if(busy())return;"));
        assertTrue(script.contains("if(visiblePanel()&&!busy())dismiss();"));
    }

    @Test
    public void shimDoesNotTouchAriaExpandedControls() {
        String script = PaseoDialogShim.injectionScript();

        // 触发按钮压根没有 aria-expanded(真机确认为 null)，改写它只会误伤
        // 模型选择等真正用这个属性的控件，让它们下次点击开不出来。
        assertFalse(script.contains("aria-expanded"));
    }

    @Test
    public void shimAlsoDismissesOnEscape() {
        String script = PaseoDialogShim.injectionScript();

        assertTrue(script.contains("addEventListener('keydown'"));
        assertTrue(script.contains("'Escape'"));
    }

    @Test
    public void shimIsIdempotentSoRepeatedInjectionIsHarmless() {
        String script = PaseoDialogShim.injectionScript();

        assertTrue(script.contains("__paseoDialogShimInstalled"));
        assertTrue(script.contains("if(window.__paseoDialogShimInstalled)return;"));
    }

    @Test
    public void shimOnlyTouchesTheThirdPartyOptimizerPanel() {
        String script = PaseoDialogShim.injectionScript();

        // webui-po- 前缀是 dsh-webui-prompt-optimizer 插件，只修这一个面板，
        // 不去动 EAC 核心的对话框。
        assertTrue(script.contains("webui-po-panel"));
        assertFalse(script.contains("ant-modal"));
        assertFalse(script.contains("[role=\"dialog\"]"));
    }

    @Test
    public void activityInjectsTheShimAfterEachPageLoad() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(activity.contains("PaseoDialogShim.injectionScript()"));
        assertTrue(activity.contains("onPageFinished"));

        // 探测阶段的 console 转发不该留在发布代码里。
        assertFalse(activity.contains("PROBE_TAG"));
    }
}
