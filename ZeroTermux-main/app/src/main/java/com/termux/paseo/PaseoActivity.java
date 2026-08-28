package com.termux.paseo;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.util.Log;
import android.text.InputType;
import android.webkit.JavascriptInterface;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import com.termux.R;
import com.termux.app.TermuxActivity;
import com.termux.app.TermuxService;
import com.termux.shared.shell.command.ExecutionCommand.Runner;
import com.termux.shared.shell.command.ExecutionCommand.ShellCreateMode;
import com.termux.shared.termux.TermuxConstants.TERMUX_APP.TERMUX_SERVICE;

import java.io.File;

public final class PaseoActivity extends Activity implements PaseoRuntimeController.Listener {
    private static final String TAG = "PaseoActivity";
    private static final String PREFERENCES = "paseo-runtime";
    private static final String KEY_PASEO_PORT = "paseo-port";
    private static final int FILE_CHOOSER_REQUEST = 6767;
    private static final int DIRECTORY_CHOOSER_REQUEST = 6768;
    /** Shell name the startup-log session is reused under. */
    private static final String SHELL_NAME_STARTUP_LOG = "Paseo startup log";

    private PaseoRuntimeController runtimeController;
    private FrameLayout root;
    private LinearLayout startupPanel;
    private LinearLayout actions;
    private ProgressBar progress;
    private TextView status;
    private WebView webView;
    private ValueCallback<Uri[]> fileChooserCallback;
    private boolean homeLoaded;
    private int paseoPort = PaseoPortConfig.DEFAULT_PORT;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        setContentView(R.layout.activity_paseo);

        root = findViewById(R.id.paseo_root);
        startupPanel = findViewById(R.id.paseo_startup_panel);
        actions = findViewById(R.id.paseo_actions);
        progress = findViewById(R.id.paseo_progress);
        status = findViewById(R.id.paseo_status);
        webView = findViewById(R.id.paseo_webview);

        Button retry = findViewById(R.id.paseo_retry);
        retry.setOnClickListener(view -> {
            actions.setVisibility(View.GONE);
            progress.setVisibility(View.VISIBLE);
            runtimeController.retry();
        });
        Button terminal = findViewById(R.id.paseo_terminal);
        terminal.setOnClickListener(view -> openTerminal());

        configureWebView();
        // Older installs kept Paseo's state in files/paseo-home while Termux sessions used
        // files/home. Fold the two together before anything reads $HOME.
        for (String problem : PaseoHome.migrateLegacyHome(getFilesDir())) {
            Log.w(TAG, "Home migration: " + problem);
        }
        runtimeController = new PaseoRuntimeController();
        SharedPreferences preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE);
        paseoPort = PaseoPortConfig.normalize(
            preferences.getInt(KEY_PASEO_PORT, PaseoPortConfig.DEFAULT_PORT));
        showPortDialog(true);
    }

    private void showPortDialog(boolean initialSelection) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_NUMBER);
        input.setSingleLine(true);
        input.setSelectAllOnFocus(true);
        input.setText(String.valueOf(paseoPort));
        int horizontalPadding = Math.round(24 * getResources().getDisplayMetrics().density);
        FrameLayout container = new FrameLayout(this);
        container.setPadding(horizontalPadding, 0, horizontalPadding, 0);
        container.addView(input, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle(R.string.paseo_port_title)
            .setMessage(R.string.paseo_port_message)
            .setView(container)
            .setPositiveButton(R.string.paseo_port_confirm, null)
            .setNegativeButton(initialSelection ? R.string.paseo_port_exit : android.R.string.cancel,
                (ignored, which) -> {
                    if (initialSelection) finish();
                })
            .setCancelable(!initialSelection)
            .create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            .setOnClickListener(view -> {
                String value = input.getText() == null ? "" : input.getText().toString();
                if (!PaseoPortConfig.isValid(value)) {
                    input.setError(getString(R.string.paseo_port_error));
                    return;
                }
                int selected = PaseoPortConfig.parse(value);
                getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit()
                    .putInt(KEY_PASEO_PORT, selected)
                    .apply();
                dialog.dismiss();
                if (initialSelection) {
                    paseoPort = selected;
                    runtimeController.start(this, this, paseoPort);
                } else if (selected != paseoPort) {
                    restartOnPort(selected);
                }
            }));
        dialog.show();
    }

    private void restartOnPort(int port) {
        paseoPort = port;
        homeLoaded = false;
        if (webView != null) {
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.setVisibility(View.GONE);
        }
        startupPanel.setVisibility(View.VISIBLE);
        progress.setVisibility(View.VISIBLE);
        actions.setVisibility(View.GONE);
        runtimeController.stop();
        runtimeController.start(this, this, paseoPort);
    }

    private String homeUrl() {
        return PaseoPortConfig.homeUrl(paseoPort);
    }

    private void configureWebView() {
        webView.setWebChromeClient(new PaseoWebChromeClient());
        webView.setWebViewClient(new PaseoWebViewClient());
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        webView.addJavascriptInterface(new PaseoAndroidBridge(), "PaseoAndroid");

        root.setFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int imeBottom = 0;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                imeBottom = ime.bottom;
            }
            int parentHeight = view.getHeight();
            if (parentHeight <= 0) parentHeight = view.getRootView().getHeight();
            ViewGroup.LayoutParams params = webView.getLayoutParams();
            int desiredHeight = imeBottom > 0 && parentHeight > imeBottom
                ? parentHeight - imeBottom : ViewGroup.LayoutParams.MATCH_PARENT;
            if (params.height != desiredHeight) {
                params.height = desiredHeight;
                webView.setLayoutParams(params);
            }
            return insets;
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == DIRECTORY_CHOOSER_REQUEST) {
            handleDirectoryResult(resultCode, data);
            return;
        }
        if (requestCode != FILE_CHOOSER_REQUEST || fileChooserCallback == null) return;
        ValueCallback<Uri[]> callback = fileChooserCallback;
        fileChooserCallback = null;
        callback.onReceiveValue(PaseoFileChooser.parseResult(resultCode, data));
    }

    private void launchDirectoryPicker() {
        try {
            startActivityForResult(
                PaseoDirectoryChooser.createChooserIntent(this, "选择工作区文件夹"),
                DIRECTORY_CHOOSER_REQUEST);
        } catch (ActivityNotFoundException error) {
            dispatchDirectoryResult("系统没有可用的目录选择器。", null, null);
        }
    }

    private void handleDirectoryResult(int resultCode, Intent data) {
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            dispatchDirectoryResult(null, null, null);
            return;
        }
        Uri treeUri = data.getData();
        if ("content".equalsIgnoreCase(treeUri.getScheme())) {
            try {
                final int takeFlags = data.getFlags() &
                    (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                getContentResolver().takePersistableUriPermission(treeUri, takeFlags);
            } catch (SecurityException | IllegalArgumentException ignored) {
                // Some providers do not offer persistable grants; the current selection is still usable.
            }
        }
        String path = PaseoDirectoryChooser.toFilesystemPath(treeUri);
        if (path == null) {
            dispatchDirectoryResult("这个目录由系统提供商管理，无法转换成 Paseo 可访问的本地路径。", null, treeUri.toString());
            return;
        }
        dispatchDirectoryResult(null, path, treeUri.toString());
    }

    private void dispatchDirectoryResult(String error, String path, String uri) {
        if (webView == null) return;
        StringBuilder detail = new StringBuilder("{ ");
        if (error != null) detail.append("error:").append(org.json.JSONObject.quote(error));
        else if (path != null) detail.append("path:").append(org.json.JSONObject.quote(path));
        else detail.append("cancelled:true");
        if (uri != null) detail.append(",uri:").append(org.json.JSONObject.quote(uri));
        detail.append(" }");
        String script = "window.dispatchEvent(new CustomEvent('paseo:directory-picked',{detail:" + detail + "}));";
        runOnUiThread(() -> webView.evaluateJavascript(script, null));
    }

    @Override
    public void onState(PaseoRuntimeState state) {
        runOnUiThread(() -> {
            status.setText(state.message());
            boolean ready = state.phase() == PaseoRuntimeState.Phase.READY;
            boolean error = state.phase() == PaseoRuntimeState.Phase.ERROR;
            if (ready) {
                startupPanel.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                if (!homeLoaded) {
                    homeLoaded = true;
                    webView.loadUrl(homeUrl());
                }
                return;
            }
            homeLoaded = false;
            startupPanel.setVisibility(View.VISIBLE);
            webView.setVisibility(View.GONE);
            progress.setVisibility(error ? View.GONE : View.VISIBLE);
            actions.setVisibility(error ? View.VISIBLE : View.GONE);
        });
    }

    private void openTerminal() {
        File startupLog = new File(PaseoHome.appDirectory(getFilesDir()), "paseo-startup.log");
        String command = "printf '\\033[2J\\033[H'; " +
            "echo 'Paseo startup log: " + startupLog.getAbsolutePath() + "'; " +
            "if [ -f '" + startupLog.getAbsolutePath() + "' ]; then tail -n 80 '" + startupLog.getAbsolutePath() + "'; else echo '日志文件尚未生成'; fi; " +
            "echo; exec /system/bin/sh -i";
        Intent intent = new Intent(
            TERMUX_SERVICE.ACTION_SERVICE_EXECUTE,
            new Uri.Builder()
                .scheme(TERMUX_SERVICE.URI_SCHEME_SERVICE_EXECUTE)
                .path("/system/bin/sh")
                .build(),
            this,
            TermuxService.class);
        intent.putExtra(TERMUX_SERVICE.EXTRA_ARGUMENTS, new String[]{"-c", command});
        intent.putExtra(TERMUX_SERVICE.EXTRA_WORKDIR,
            PaseoHome.directory(getFilesDir()).getAbsolutePath());
        intent.putExtra(TERMUX_SERVICE.EXTRA_RUNNER, Runner.TERMINAL_SESSION.getName());
        intent.putExtra(
            TERMUX_SERVICE.EXTRA_SESSION_ACTION,
            Integer.toString(TERMUX_SERVICE.VALUE_EXTRA_SESSION_ACTION_SWITCH_TO_NEW_SESSION_AND_OPEN_ACTIVITY));
        intent.putExtra(TERMUX_SERVICE.EXTRA_SHELL_NAME, SHELL_NAME_STARTUP_LOG);
        // Without an explicit create mode TermuxService.processShellCreateMode() falls back
        // to ShellCreateMode.ALWAYS, so the shell name above is never matched and every tap
        // on "Open terminal" mints another surviving session. NO_SHELL_WITH_NAME makes the
        // service reuse the existing log session instead.
        intent.putExtra(TERMUX_SERVICE.EXTRA_SHELL_CREATE_MODE,
            ShellCreateMode.NO_SHELL_WITH_NAME.getMode());
        startService(intent);
    }

    private void launchTermuxActivity() {
        try {
            startActivity(new Intent(PaseoActivity.this, TermuxActivity.class));
        } catch (ActivityNotFoundException error) {
            Log.e(TAG, "TermuxActivity is unavailable; opening the Paseo shell service instead", error);
            openTerminal();
        }
    }

    private final class PaseoAndroidBridge {
        @JavascriptInterface
        public void pickWorkspaceDirectory() {
            runOnUiThread(PaseoActivity.this::launchDirectoryPicker);
        }

        @JavascriptInterface
        public void openTermuxTerminal() {
            Log.i(TAG, "WebView requested native Termux terminal");
            runOnUiThread(PaseoActivity.this::launchTermuxActivity);
        }

        @JavascriptInterface
        public void changePaseoPort() {
            runOnUiThread(() -> showPortDialog(false));
        }
    }

    private void openExternalUrl(String url) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, R.string.paseo_no_browser, Toast.LENGTH_LONG).show();
        }
    }

    private boolean handleNavigation(WebView view, String url) {
        PaseoNavigationPolicy.Decision decision = PaseoNavigationPolicy.decide(url, paseoPort);
        if (decision == PaseoNavigationPolicy.Decision.ALLOW_LOCAL) return false;
        if (decision == PaseoNavigationPolicy.Decision.OPEN_HOME) {
            view.loadUrl(homeUrl());
        } else if (decision == PaseoNavigationPolicy.Decision.OPEN_EXTERNAL) {
            openExternalUrl(url);
        }
        return true;
    }

    private void handlePopupNavigation(WebView popup, String url) {
        PaseoNavigationPolicy.Decision decision = PaseoNavigationPolicy.decide(url, paseoPort);
        if (decision == PaseoNavigationPolicy.Decision.ALLOW_LOCAL) {
            webView.loadUrl(url);
        } else if (decision == PaseoNavigationPolicy.Decision.OPEN_HOME) {
            webView.loadUrl(homeUrl());
        } else if (decision == PaseoNavigationPolicy.Decision.OPEN_EXTERNAL) {
            openExternalUrl(url);
        }
        popup.stopLoading();
        popup.destroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (runtimeController != null) runtimeController.stop();
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private final class PaseoWebChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(
            WebView view,
            ValueCallback<Uri[]> callback,
            FileChooserParams params) {
            if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = callback;
            Intent chooser = PaseoFileChooser.createIntent(
                params == null ? null : params.getAcceptTypes(),
                params == null ? FileChooserParams.MODE_OPEN : params.getMode());
            try {
                startActivityForResult(Intent.createChooser(chooser, "Choose image or attachment"),
                    FILE_CHOOSER_REQUEST);
                return true;
            } catch (ActivityNotFoundException error) {
                fileChooserCallback = null;
                callback.onReceiveValue(null);
                return false;
            }
        }

        @Override
        public boolean onCreateWindow(
            WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            if (!isUserGesture || resultMsg == null ||
                !(resultMsg.obj instanceof WebView.WebViewTransport)) {
                return false;
            }
            WebView popup = new WebView(PaseoActivity.this);
            popup.setWebViewClient(new PopupWebViewClient());
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }

        @Override
        public void onCloseWindow(WebView window) {
            if (window != null) window.destroy();
        }
    }

    private final class PaseoWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNavigation(view, url);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleNavigation(view, request.getUrl().toString());
        }

        private boolean handleNavigation(WebView view, String url) {
            return PaseoActivity.this.handleNavigation(view, url);
        }
    }

    private final class PopupWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            handlePopupNavigation(view, url);
            return true;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            handlePopupNavigation(view, request.getUrl().toString());
            return true;
        }
    }
}
