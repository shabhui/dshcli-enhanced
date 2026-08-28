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
        assertTrue(activity.contains("runOnUiThread(PaseoActivity.this::launchTermuxActivity)"));
    }

    @Test
    public void directoryPickerDoesNotRequireLegacyStoragePermissions() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertFalse(activity.contains("requestPermissions("));
        assertFalse(activity.contains("READ_EXTERNAL_STORAGE"));
        assertFalse(activity.contains("WRITE_EXTERNAL_STORAGE"));
    }

    @Test
    public void activityPromptsForAndPersistsThePaseoPortBeforeStartingRuntime() throws Exception {
        File activityFile = new File("src/main/java/com/termux/paseo/PaseoActivity.java");
        String activity = new String(
            Files.readAllBytes(activityFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(activity.contains("getSharedPreferences"));
        assertTrue(activity.contains("KEY_PASEO_PORT"));
        assertTrue(activity.contains("showPortDialog"));
        assertTrue(activity.contains("InputType.TYPE_CLASS_NUMBER"));
        assertTrue(activity.contains("runtimeController.start(this, this, paseoPort)"));
        assertFalse(activity.contains("HOME_URL = \"http://127.0.0.1:6767/\""));
    }

    @Test
    public void chineseLocaleTranslatesThePaseoPortDialog() throws Exception {
        File stringsFile = new File("src/main/res/values-zh-rCN/strings.xml");
        String strings = new String(
            Files.readAllBytes(stringsFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(strings.contains("<string name=\"paseo_no_browser\">没有可用的浏览器来打开此链接。</string>"));
        assertTrue(strings.contains("<string name=\"paseo_port_title\">Paseo 端口</string>"));
        assertTrue(strings.contains("<string name=\"paseo_port_message\">请选择本地服务和网页端口。端口 6768 已被内部 Codex 代理占用。</string>"));
        assertTrue(strings.contains("<string name=\"paseo_port_confirm\">启动</string>"));
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
