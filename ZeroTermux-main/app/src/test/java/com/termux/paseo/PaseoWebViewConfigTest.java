package com.termux.paseo;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Test;

public class PaseoWebViewConfigTest {

    @Test
    public void webViewAllowsPickerContentUrisWithoutAllowingFileUrls() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(activity.contains("settings.setAllowContentAccess(true)"));
        assertTrue(activity.contains("settings.setAllowFileAccess(false)"));
        assertFalse(activity.contains("settings.setAllowContentAccess(false)"));
    }

    @Test
    public void activityUsesTheWebFloatingToolbarInsteadOfASecondNativeShortcut() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        File layoutFile = new File("src/main/res/layout/activity_paseo.xml");
        String layout = new String(
            Files.readAllBytes(layoutFile.toPath()), StandardCharsets.UTF_8);

        assertFalse(activity.contains("R.id.paseo_terminal_shortcut"));
        assertFalse(layout.contains("@+id/paseo_terminal_shortcut"));
        assertTrue(activity.contains("Decision.OPEN_EXTERNAL"));
        assertTrue(activity.contains("Intent.ACTION_VIEW"));
        assertTrue(activity.contains("ActivityNotFoundException"));
        assertTrue(activity.contains("onCreateWindow"));
    }

    @Test
    public void nativeControlSurfaceKeepsTheDshaLaunchStructure() throws Exception {
        File layoutFile = new File("src/main/res/layout/activity_paseo.xml");
        String layout = new String(
            Files.readAllBytes(layoutFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(layout.contains("@+id/launch_home"));
        assertTrue(layout.contains("style=\"@style/DshaCard\""));
        assertTrue(layout.contains("@+id/launch_run_dot"));
        assertTrue(layout.contains("@+id/launch_run_state"));
        assertTrue(layout.contains("@+id/launch_status"));
        assertTrue(layout.contains("@+id/launch_busy"));
        assertTrue(layout.contains("@+id/launch_controls"));
        assertTrue(layout.contains("@+id/launch_start"));
        assertTrue(layout.contains("@+id/launch_open"));
        assertTrue(layout.contains("@+id/launch_stop"));
        assertTrue(layout.contains("@+id/lan_addr"));
        assertTrue(layout.contains("@+id/launch_log_scroll"));
        assertTrue(layout.contains("@+id/launch_log"));
        assertTrue(layout.contains("@+id/launch_web"));
        assertTrue(layout.contains("@+id/paseo_port"));
        assertTrue(layout.contains("@+id/paseo_terminal"));
        assertTrue(layout.contains("@+id/paseo_refresh_log"));
        assertTrue("weighted rows keep Chinese command labels inside narrow screens",
            layout.contains("android:layout_weight=\"1\""));

        int webView = layout.indexOf("@+id/paseo_webview");
        assertTrue(webView >= 0);
        String webViewTail = layout.substring(webView);
        assertTrue(webViewTail.contains("android:layout_width=\"match_parent\""));
        assertTrue(webViewTail.contains("android:layout_height=\"match_parent\""));
        assertTrue(webViewTail.contains("android:visibility=\"gone\""));
    }

    @Test
    public void nativeControlSurfaceHasEnglishAndChineseCommandCopy() throws Exception {
        String defaults = new String(Files.readAllBytes(
            new File("src/main/res/values/strings.xml").toPath()), StandardCharsets.UTF_8);
        String chinese = new String(Files.readAllBytes(
            new File("src/main/res/values-zh-rCN/strings.xml").toPath()), StandardCharsets.UTF_8);

        for (String name : new String[]{
            "paseo_state_preparing", "paseo_state_starting",
            "paseo_state_running", "paseo_state_stopped", "paseo_state_error",
            "paseo_endpoint_label", "paseo_log_title", "paseo_logs_empty",
            "paseo_action_start", "paseo_action_enter", "paseo_action_restart",
            "paseo_action_stop", "paseo_action_port", "paseo_action_copy_address",
            "paseo_action_refresh_log"}) {
            assertTrue("missing default string " + name,
                defaults.contains("<string name=\"" + name + "\">"));
            assertTrue("missing zh-rCN string " + name,
                chinese.contains("<string name=\"" + name + "\">"));
        }

        assertTrue(chinese.contains("<string name=\"paseo_action_start\">启动</string>"));
        assertTrue(chinese.contains("<string name=\"paseo_action_enter\">进入</string>"));
        assertTrue(chinese.contains("<string name=\"paseo_action_restart\">重启</string>"));
        assertTrue(chinese.contains("<string name=\"paseo_action_stop\">停止</string>"));
    }

    @Test
    public void copiedDshaLaunchShellKeepsItsMitAttribution() throws Exception {
        String notices = new String(Files.readAllBytes(
            new File("../../THIRD_PARTY_NOTICES.md").toPath()), StandardCharsets.UTF_8);

        assertTrue(notices.contains("## DSHA Android launch shell"));
        assertTrue(notices.contains("https://github.com/qiannianhuanxiang/DSHA"));
        assertTrue(notices.contains("Copyright (c) 2026 qiannianhuanxiang"));
        assertTrue(notices.contains("MIT License"));
    }

    @Test
    public void dshaLaunchShellUsesAConsistentDayNightPaseoTheme() throws Exception {
        String themes = new String(Files.readAllBytes(
            new File("src/main/res/values/themes.xml").toPath()), StandardCharsets.UTF_8);
        File nightThemesFile = new File("src/main/res/values-night/themes.xml");
        assertTrue(nightThemesFile.isFile());
        String nightThemes = new String(Files.readAllBytes(
            nightThemesFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(themes.contains(
            "<style name=\"Theme.Paseo\" parent=\"Theme.AppCompat.DayNight.NoActionBar\">"));
        assertTrue(themes.contains(
            "<item name=\"android:windowBackground\">@color/paseo_dsha_surface</item>"));
        assertTrue(themes.contains(
            "<item name=\"android:windowLightStatusBar\">true</item>"));
        assertTrue(nightThemes.contains("<style name=\"Theme.Paseo\""));
        assertTrue(nightThemes.contains(
            "<item name=\"android:windowLightStatusBar\">false</item>"));
    }

    @Test
    public void terminalEntryShowsRecentStartupLogThenOpensAnInteractiveShell() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(activity.contains("ACTION_SERVICE_EXECUTE"));
        assertTrue(activity.contains("paseo-startup.log"));
        assertTrue(activity.contains("tail -n 80"));
        assertTrue(activity.contains("exec /system/bin/sh -i"));
        assertFalse(activity.contains("tail -n 200 -f"));
        assertTrue(activity.contains("VALUE_EXTRA_SESSION_ACTION_SWITCH_TO_NEW_SESSION_AND_OPEN_ACTIVITY"));
    }

    @Test
    public void activityExposesTheNativeWorkspaceDirectoryBridge() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(activity.contains("addJavascriptInterface"));
        assertTrue(activity.contains("pickWorkspaceDirectory"));
        assertTrue(activity.contains("PaseoDirectoryChooser.createChooserIntent"));
        assertTrue(activity.contains("takePersistableUriPermission"));
        assertTrue(activity.contains("\"content\".equalsIgnoreCase(treeUri.getScheme())"));
        assertTrue(activity.contains("paseo:directory-picked"));
    }

    @Test
    public void activityExposesTheNativeTermuxBridge() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(activity.contains("openTermuxTerminal"));
        assertTrue(activity.contains("new Intent(PaseoActivity.this, TermuxActivity.class)"));
        assertTrue(activity.contains("if (!isLocalBridgeAllowed()) return;"));
    }

    @Test
    public void nativeBridgeAndAndroidShimsAreRestrictedToTheLocalPaseoPage() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(activity.contains("private boolean isLocalWebViewPage(String url)"));
        assertTrue(activity.contains("private boolean isLocalBridgeAllowed()"));
        assertTrue(activity.contains("if (isLocalBridgeAllowed()) launchDirectoryPicker()"));
        assertTrue(activity.contains("if (isLocalBridgeAllowed()) showPortDialog()"));
        assertTrue(activity.contains("if (!isLocalBridgeAllowed() || webView == null) return;"));
        assertTrue(activity.contains("if (!isLocalWebViewPage(url)) return;"));
    }

    @Test
    public void directoryPickerRequestsStoragePermissionForSharedStoragePaths() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        // SAF 的授权只覆盖 content URI;EAC 的 node 走真实文件系统路径,共享存储目录
        // 必须另有 WRITE_EXTERNAL_STORAGE(targetSdk 28 的 legacy storage 视图),
        // 否则选了目录也 EACCES。选完 /storage 下的目录时权限请求在
        // handleDirectoryResult 里补发。
        assertTrue(activity.contains("requestPermissions("));
        assertTrue(activity.contains("WRITE_EXTERNAL_STORAGE"));
        assertFalse(activity.contains("READ_EXTERNAL_STORAGE"));
        String coldStart = activity.substring(activity.indexOf("protected void onCreate("),
            activity.indexOf("private boolean hasStoragePermission("));
        assertFalse(coldStart.contains("requestStoragePermissionIfNeeded()"));
        assertTrue(activity.contains("pendingDirectoryPath = path"));
        assertTrue(activity.contains("onRequestPermissionsResult("));
    }

    @Test
    public void activityStartsImmediatelyAndKeepsPortAsASecondarySetting() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(activity.contains("getSharedPreferences"));
        assertTrue(activity.contains("KEY_PASEO_PORT"));
        assertTrue(activity.contains("findViewById(R.id.paseo_port)"));
        assertTrue(activity.contains("showPortDialog()"));
        assertTrue(activity.contains("InputType.TYPE_CLASS_NUMBER"));
        assertTrue(activity.contains("startRuntime()"));
        assertFalse(activity.contains("showPortDialog(true)"));
        assertFalse(activity.contains("HOME_URL = \"http://127.0.0.1:6767/\""));
    }

    @Test
    public void activityUsesTheDshaStartEnterRestartStopAndBackFlow() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(activity.contains("findViewById(R.id.launch_home)"));
        assertTrue(activity.contains("findViewById(R.id.launch_web)"));
        assertTrue(activity.contains("findViewById(R.id.launch_start)"));
        assertTrue(activity.contains("findViewById(R.id.launch_open)"));
        assertTrue(activity.contains("findViewById(R.id.launch_stop)"));
        assertTrue(activity.contains("private void startRuntime()"));
        assertTrue(activity.contains("private void restartRuntime()"));
        assertTrue(activity.contains("private void stopRuntime()"));
        assertTrue(activity.contains("private void showWebView()"));
        assertTrue(activity.contains("private void showControlPanel()"));
        assertTrue(activity.contains("initialEacUrlPending ? eacTarget.initialUrl()"));
        assertTrue(activity.contains(": eacTarget.homeUrl()"));
        assertTrue(activity.contains("initialEacUrlPending = false"));

        int onBackPressed = activity.indexOf("public void onBackPressed()");
        int showControlPanel = activity.indexOf("showControlPanel()", onBackPressed);
        int superBack = activity.indexOf("super.onBackPressed()", onBackPressed);
        assertTrue(onBackPressed >= 0 && showControlPanel > onBackPressed && superBack > showControlPanel);
    }

    @Test
    public void eacLauncherUsesTheInstalledSidecarAndItsOneTimeReadyUrl() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(activity.contains("private boolean launchEacIfInstalled(File runtimeDirectory)"));
        assertTrue(activity.contains("EacRuntimeLayout.isInstalled(runtimeDirectory)"));
        assertTrue(activity.contains("new File(getFilesDir(), \"usr/bin/node\")"));
        assertTrue(activity.contains("EacRuntimeLayout.sidecarEntry(runtimeDirectory)"));
        assertTrue(activity.contains("EAC_LIFECYCLE_EXECUTOR.execute(() ->"));
        assertTrue(activity.contains("client.start(getFilesDir()"));
        assertTrue(activity.contains("EacWebTarget.parse(webUrl)"));
        assertTrue(activity.contains(
            "PaseoNavigationPolicy.decideExact(target.initialUrl(), target.port())"));
        assertTrue(activity.contains("onFailed(String error)"));

        int readyStart = activity.indexOf("public void onWebReady(String webUrl, int port)");
        int failureStart = activity.indexOf("public void onFailed(String error)", readyStart);
        assertTrue(readyStart >= 0 && failureStart > readyStart);
        String readyHandler = activity.substring(readyStart, failureStart);
        assertTrue(readyHandler.contains("initialEacUrlPending = true"));
        assertTrue(readyHandler.contains("renderControlState(EacControlState.running"));
        assertFalse("ready must stop at the native control page", readyHandler.contains("webView.loadUrl"));
    }

    @Test
    public void eacNavigationUsesTheReportedPortAndCookieManager() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(activity.contains("CookieManager.getInstance().setAcceptCookie(true)"));
        assertTrue(activity.contains("eacTarget.homeUrl()"));
        assertTrue(activity.contains("PaseoPortConfig.homeUrl(paseoPort)"));

        // 判定集中到 decideNavigation 之后,这里断言规则本身,而不是某一次调用的写法。
        // 规则没变:sidecar 报的端口必须原样比对 —— normalize 会把它改掉
        // (报 6768 或 80 都会变成 6767),之后每一次站内跳转都被 BLOCK 成白屏。
        int helper = activity.indexOf(
            "private PaseoNavigationPolicy.Decision decideNavigation(String url) {");
        assertTrue("导航判定必须集中在 decideNavigation", helper >= 0);
        String helperBody = activity.substring(helper, activity.indexOf("\n    }", helper));
        assertTrue(helperBody.contains("eacTarget.port()"));
        assertFalse("绝不能 normalize sidecar 报的端口",
            helperBody.contains("normalize(eacTarget.port())"));
        assertTrue("没有 sidecar 时端口才是用户输入,那时才 normalize",
            helperBody.contains("PaseoPortConfig.normalize(paseoPort)"));
    }

    @Test
    public void eacClientIsStoppedAndReferencesClearedOnStopRestartAndDestroy() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(activity.contains("private void stopEacClient()"));
        assertTrue(activity.contains("eacClient = null"));
        assertTrue(activity.contains("eacTarget = null"));
        assertTrue(activity.contains("EAC_LIFECYCLE_EXECUTOR.execute(client::stop)"));
        assertTrue(activity.indexOf("eacClient = null") <
            activity.indexOf("EAC_LIFECYCLE_EXECUTOR.execute(client::stop)"));
        int stopRuntimeMethod = activity.indexOf("private void stopRuntime()");
        int stopFromControl = activity.indexOf("stopEacClient()", stopRuntimeMethod);
        int restartRuntimeMethod = activity.indexOf("private void restartRuntime()");
        int stopForRestart = activity.indexOf("stopEacClient()", restartRuntimeMethod);
        assertTrue(stopRuntimeMethod >= 0 && stopFromControl > stopRuntimeMethod);
        assertTrue(restartRuntimeMethod >= 0 && stopForRestart > restartRuntimeMethod);
        int onDestroy = activity.indexOf("protected void onDestroy()");
        int stopSidecar = activity.indexOf("stopEacClient()", onDestroy);
        int stopRuntime = activity.indexOf("runtimeController.stop()", onDestroy);
        assertTrue(onDestroy >= 0 && stopSidecar > onDestroy && stopRuntime > stopSidecar);
    }

    @Test
    public void chineseLocaleTranslatesThePaseoPortDialog() throws Exception {
        File stringsFile = new File("src/main/res/values-zh-rCN/strings.xml");
        String strings = new String(
            Files.readAllBytes(stringsFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(strings.contains("<string name=\"paseo_no_browser\">没有可用的浏览器来打开此链接。</string>"));
        assertTrue(strings.contains("<string name=\"paseo_port_title\">Paseo 端口</string>"));
        assertTrue(strings.contains("<string name=\"paseo_port_message\">修改 Paseo 的后备端口。EAC 始终使用 sidecar 实际返回的端口。端口 6768 已被内部 Codex 代理占用。</string>"));
        assertTrue(strings.contains("<string name=\"paseo_port_confirm\">应用</string>"));
        assertTrue(strings.contains("<string name=\"paseo_port_exit\">退出</string>"));
        assertTrue(strings.contains("<string name=\"paseo_port_error\">请输入 1024 至 65535 之间的端口，不能使用 6768。</string>"));
    }

    @Test
    public void privateHomeDocumentProviderUsesThePaseoEnhancedName() throws Exception {
        File providerFile = new File(
            "src/main/java/com/termux/filepicker/TermuxDocumentsProvider.java");
        String provider = new String(
            Files.readAllBytes(providerFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(provider.contains("getString(R.string.app_name)"));
        assertFalse(provider.contains("getString(R.string.application_name)"));
        assertTrue(provider.contains("BASE_DIR.mkdirs()"));
    }

}
