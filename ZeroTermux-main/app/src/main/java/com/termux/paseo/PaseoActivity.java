package com.termux.paseo;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
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
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.Button;
import android.widget.EditText;

import com.termux.BuildConfig;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.termux.R;
import com.termux.app.TermuxActivity;
import com.termux.app.TermuxService;
import com.termux.shared.shell.command.ExecutionCommand.Runner;
import com.termux.shared.shell.command.ExecutionCommand.ShellCreateMode;
import com.termux.shared.termux.TermuxConstants.TERMUX_APP.TERMUX_SERVICE;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class PaseoActivity extends Activity implements PaseoRuntimeController.Listener {
    private static final String TAG = "PaseoActivity";
    private static final String PREFERENCES = "paseo-runtime";
    private static final String KEY_PASEO_PORT = "paseo-port";
    /** 存的是 origin(不带 token)—— token 是一次性的,存下来下次也用不了。 */
    private static final String KEY_REMOTE_ORIGIN = "paseo-remote-origin";
    private static final int FILE_CHOOSER_REQUEST = 6767;
    private static final int DIRECTORY_CHOOSER_REQUEST = 6768;
    private static final int STORAGE_PERMISSION_REQUEST = 6769;
    private static final int EAC_LOG_MAX_BYTES = 24_000;
    /** Shell name the startup-log session is reused under. */
    private static final String SHELL_NAME_STARTUP_LOG = "Paseo startup log";
    private static final ExecutorService EAC_LIFECYCLE_EXECUTOR =
        Executors.newSingleThreadExecutor(command -> {
            Thread thread = new Thread(command, "eac-sidecar-lifecycle");
            thread.setDaemon(true);
            return thread;
        });

    private PaseoRuntimeController runtimeController;
    private FrameLayout root;
    private LinearLayout homePane;
    private FrameLayout webPane;
    private ProgressBar busy;
    private TextView runDot;
    private TextView runState;
    private TextView status;
    private TextView endpoint;
    private TextView logText;
    private ScrollView logScroll;
    private Button startButton;
    private Button restartButton;
    private Button stopButton;
    private Button connectComputerButton;
    private WebView webView;
    private ValueCallback<Uri[]> fileChooserCallback;
    private int paseoPort = PaseoPortConfig.DEFAULT_PORT;
    private EacControlState controlState = EacControlState.stopped("EAC is stopped");
    private boolean initialEacUrlPending;
    private volatile long logRefreshGeneration;
    private final Object sidecarLogLock = new Object();
    private final StringBuilder sidecarLog = new StringBuilder();
    /** Non-null once the EAC payload is present and its sidecar has been spawned. */
    private volatile EacSidecarClient eacClient;
    /** Non-null once the sidecar has reported its web service; source of the URL and the port. */
    private EacWebTarget eacTarget;
    /** Rejects callbacks from a sidecar that was stopped by retry or port change. */
    private volatile long eacLaunchGeneration;
    /** 「连接电脑」保存的地址;{@code null} 表示没连。只出站,本机不开监听端口。 */
    private PaseoRemoteTarget remoteTarget;
    /** WebView 当前显示的是不是那台电脑。和 {@link #remoteTarget} 分开:地址记着,但用户可以回本机。 */
    private boolean remoteActive;
    /** 与 {@link #initialEacUrlPending} 同一个规则:token 只能用一次,之后必须裸 origin。 */
    private boolean initialRemoteUrlPending;
    /** 选了共享存储目录但存储权限还没批时,先把 SAF 结果挂在这里,等权限回调再发给 WebView。 */
    private String pendingDirectoryPath;
    private String pendingDirectoryUri;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        setContentView(R.layout.activity_paseo);

        root = findViewById(R.id.paseo_root);
        homePane = findViewById(R.id.launch_home);
        webPane = findViewById(R.id.launch_web);
        busy = findViewById(R.id.launch_busy);
        runDot = findViewById(R.id.launch_run_dot);
        runState = findViewById(R.id.launch_run_state);
        status = findViewById(R.id.launch_status);
        endpoint = findViewById(R.id.lan_addr);
        logText = findViewById(R.id.launch_log);
        logScroll = findViewById(R.id.launch_log_scroll);
        webView = findViewById(R.id.paseo_webview);

        startButton = findViewById(R.id.launch_start);
        startButton.setOnClickListener(view -> {
            if (controlState.canEnter()) showWebView();
            else if (controlState.canStart()) startRuntime();
        });
        restartButton = findViewById(R.id.launch_open);
        restartButton.setOnClickListener(view -> restartRuntime());
        stopButton = findViewById(R.id.launch_stop);
        stopButton.setOnClickListener(view -> stopRuntime());
        endpoint.setOnClickListener(view -> copyLocalAddress());
        Button port = findViewById(R.id.paseo_port);
        port.setOnClickListener(view -> showPortDialog());
        Button terminal = findViewById(R.id.paseo_terminal);
        terminal.setOnClickListener(view -> openTerminal());
        Button refreshLog = findViewById(R.id.paseo_refresh_log);
        refreshLog.setOnClickListener(view -> refreshEacLog());
        connectComputerButton = findViewById(R.id.paseo_connect_computer);
        connectComputerButton.setOnClickListener(view -> showRemoteDialog());

        configureWebView();
        // Older installs kept Paseo's state in files/paseo-home while Termux sessions used
        // files/home. Fold the two together before anything reads $HOME.
        for (String problem : PaseoHome.migrateLegacyHome(getFilesDir())) {
            Log.w(TAG, "Home migration: " + problem);
        }
        runtimeController = new PaseoRuntimeController();
        // Takes over after bootstrap and asset install when the EAC payload is on disk; declines
        // otherwise, leaving Paseo's own daemon path untouched.
        runtimeController.setRuntimeLauncher(this::launchEacIfInstalled);
        SharedPreferences preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE);
        paseoPort = PaseoPortConfig.normalize(
            preferences.getInt(KEY_PASEO_PORT, PaseoPortConfig.DEFAULT_PORT));
        // 记住上次连的电脑,但不自动跳过去 —— 冷启动落在控制页是既有行为。
        remoteTarget = PaseoRemoteTarget.parse(preferences.getString(KEY_REMOTE_ORIGIN, null));
        renderRemoteButton();
        renderControlState(EacControlState.stopped(getString(R.string.paseo_status_eac_stopped)));
        startRuntime();
    }

    private boolean hasStoragePermission() {
        return checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED;
    }

    private void requestStoragePermissionIfNeeded() {
        if (hasStoragePermission()) return;
        requestPermissions(
            new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
            STORAGE_PERMISSION_REQUEST);
    }

    private void showPortDialog() {
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
            .setNegativeButton(android.R.string.cancel, null)
            .setCancelable(true)
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
                if (selected != paseoPort) restartOnPort(selected);
            }));
        dialog.show();
    }

    private void restartOnPort(int port) {
        paseoPort = port;
        restartRuntime();
    }

    private void startRuntime() {
        if (runtimeController == null) return;
        showControlPanel();
        stopEacClient();
        clearWebView();
        runtimeController.stop();
        renderControlState(EacControlState.preparing(
            getString(R.string.paseo_status_preparing_runtime)));
        runtimeController.start(this, this, paseoPort);
    }

    private void restartRuntime() {
        if (runtimeController == null) return;
        showControlPanel();
        stopEacClient();
        clearWebView();
        runtimeController.stop();
        renderControlState(EacControlState.preparing(
            getString(R.string.paseo_status_preparing_runtime)));
        runtimeController.start(this, this, paseoPort);
    }

    private void stopRuntime() {
        showControlPanel();
        stopEacClient();
        if (runtimeController != null) runtimeController.stop();
        clearWebView();
        renderControlState(EacControlState.stopped(
            getString(R.string.paseo_status_eac_stopped)));
        refreshEacLog();
    }

    private void clearWebView() {
        // 本机停/启会清 WebView。这只说明页面不再显示那台电脑,不代表用户断开了它 ——
        // 地址留着,下次点「电脑 · host:port」还能直接进。
        remoteActive = false;
        if (webView != null) {
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.setVisibility(View.GONE);
        }
    }

    /**
     * 「连接电脑」。方向和桌面版 {@code dsh-phone} 相反:我们只往外连,本机不开监听端口,
     * 所以没有把这台手机的 agent 暴露到局域网的问题。
     *
     * <p>确定键始终是「连接并进入」,包括地址没改的情况 —— 从控制页回来时不用先断开再连。
     */
    private void showRemoteDialog() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setSelectAllOnFocus(true);
        input.setHint(R.string.paseo_remote_hint);
        if (remoteTarget != null) input.setText(remoteTarget.label());
        int horizontalPadding = Math.round(24 * getResources().getDisplayMetrics().density);
        FrameLayout container = new FrameLayout(this);
        container.setPadding(horizontalPadding, 0, horizontalPadding, 0);
        container.addView(input, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        AlertDialog.Builder builder = new AlertDialog.Builder(this)
            .setTitle(R.string.paseo_remote_title)
            .setMessage(R.string.paseo_remote_message)
            .setView(container)
            .setPositiveButton(R.string.paseo_remote_confirm, null)
            .setNegativeButton(android.R.string.cancel, null);
        if (remoteTarget != null) {
            builder.setNeutralButton(R.string.paseo_remote_disconnect,
                (ignored, which) -> disconnectComputer());
        }
        AlertDialog dialog = builder.setCancelable(true).create();
        // 校验失败时不能让对话框关掉,所以确定键的监听要在 show 之后自己挂。
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            .setOnClickListener(view -> {
                String value = input.getText() == null ? "" : input.getText().toString();
                PaseoRemoteTarget parsed = PaseoRemoteTarget.parse(value);
                if (parsed == null) {
                    input.setError(getString(R.string.paseo_remote_error));
                    return;
                }
                dialog.dismiss();
                connectComputer(parsed);
            }));
        dialog.show();
    }

    private void connectComputer(PaseoRemoteTarget target) {
        remoteTarget = target;
        // 存 origin 而不是原始输入:token 用过就失效,存下来只会让下次进入 401。
        getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit()
            .putString(KEY_REMOTE_ORIGIN, target.origin())
            .apply();
        renderRemoteButton();
        initialRemoteUrlPending = true;
        enterRemote();
    }

    private void disconnectComputer() {
        remoteTarget = null;
        remoteActive = false;
        initialRemoteUrlPending = false;
        getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit()
            .remove(KEY_REMOTE_ORIGIN)
            .apply();
        renderRemoteButton();
        clearWebView();
        showControlPanel();
        Toast.makeText(this, R.string.paseo_remote_disconnected, Toast.LENGTH_SHORT).show();
    }

    /**
     * 进入那台电脑的页面。刻意不看 {@link #controlState} —— 看的是别人的机器,
     * 本机 sidecar 起没起来与此无关。
     */
    private void enterRemote() {
        if (remoteTarget == null || webView == null) return;
        remoteActive = true;
        String url = initialRemoteUrlPending ? remoteTarget.initialUrl() : remoteTarget.homeUrl();
        initialRemoteUrlPending = false;
        homePane.setVisibility(View.GONE);
        webPane.setVisibility(View.VISIBLE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(url);
    }

    private void renderRemoteButton() {
        if (connectComputerButton == null) return;
        connectComputerButton.setText(remoteTarget == null
            ? getString(R.string.paseo_action_connect_computer)
            : getString(R.string.paseo_remote_connected, remoteTarget.label()));
    }

    private boolean launchEacIfInstalled(File runtimeDirectory) {
        if (!EacRuntimeLayout.isInstalled(runtimeDirectory)) return false;

        stopEacClient();
        eacTarget = null;
        synchronized (sidecarLogLock) {
            sidecarLog.setLength(0);
        }
        final long launchGeneration = ++eacLaunchGeneration;
        File node = new File(getFilesDir(), "usr/bin/node");
        File sidecar = EacRuntimeLayout.sidecarEntry(runtimeDirectory);
        final EacSidecarClient client = new EacSidecarClient(new EacSidecarClient.Listener() {
            @Override
            public void onWebReady(String webUrl, int port) {
                EacWebTarget target = EacWebTarget.parse(webUrl);
                if (target == null || target.port() != port ||
                    PaseoNavigationPolicy.decideExact(target.initialUrl(), target.port()) !=
                        PaseoNavigationPolicy.Decision.ALLOW_LOCAL) {
                    onFailed("EAC sidecar returned an invalid web target");
                    return;
                }
                runOnUiThread(() -> {
                    if (eacLaunchGeneration != launchGeneration || eacClient == null) return;
                    eacTarget = target;
                    initialEacUrlPending = true;
                    renderControlState(EacControlState.running(
                        getString(R.string.paseo_state_running), target.homeUrl()));
                    showControlPanel();
                    refreshEacLog();
                });
            }

            @Override
            public void onFailed(String error) {
                runOnUiThread(() -> {
                    if (eacLaunchGeneration != launchGeneration || eacClient == null) return;
                    eacTarget = null;
                    initialEacUrlPending = false;
                    renderControlState(EacControlState.error(
                        error == null || error.trim().isEmpty()
                            ? getString(R.string.paseo_state_error) : error));
                    showControlPanel();
                    refreshEacLog();
                });
            }

            @Override
            public void onLog(String message) {
                recordSidecarLog(message);
            }

            @Override
            public void onServerDied(String error, String logPath) {
                runOnUiThread(() -> {
                    if (eacLaunchGeneration != launchGeneration || eacClient == null) return;
                    eacTarget = null;
                    initialEacUrlPending = false;
                    String detail = logPath == null || logPath.trim().isEmpty()
                        ? error : error + "\n" + logPath;
                    renderControlState(EacControlState.error(detail));
                    showControlPanel();
                    refreshEacLog();
                });
            }
        });
        eacClient = client;
        onState(new PaseoRuntimeState(
            PaseoRuntimeState.Phase.STARTING, getString(R.string.paseo_status_starting_eac)));
        EAC_LIFECYCLE_EXECUTOR.execute(() -> {
            if (eacLaunchGeneration != launchGeneration || eacClient != client) return;
            try {
                client.start(getFilesDir(), node.getAbsolutePath(), sidecar.getAbsolutePath());
            } catch (IOException error) {
                runOnUiThread(() -> {
                    if (eacLaunchGeneration != launchGeneration || eacClient != client) return;
                    eacClient = null;
                    eacTarget = null;
                    onState(new PaseoRuntimeState(
                        PaseoRuntimeState.Phase.ERROR, messageFor(error)));
                });
            }
        });
        return true;
    }

    private void stopEacClient() {
        EacSidecarClient client = eacClient;
        eacClient = null;
        eacTarget = null;
        eacLaunchGeneration++;
        initialEacUrlPending = false;
        if (client != null) EAC_LIFECYCLE_EXECUTOR.execute(client::stop);
    }

    private static String messageFor(Exception error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
            ? error.getClass().getSimpleName() : message;
    }

    private String homeUrl() {
        // 显示远程时,paseo://open 要回那台电脑的首页,不是本机的 —— 否则站内「回首页」
        // 会把用户静默切回本机。裸 origin:token 已经用掉了。
        if (remoteActive && remoteTarget != null) return remoteTarget.homeUrl();
        return eacTarget == null ? PaseoPortConfig.homeUrl(paseoPort) : eacTarget.homeUrl();
    }

    /** 本机侧口径:sidecar 报的端口是事实,不能再 normalize;没有 sidecar 时才是用户输入。 */
    private PaseoNavigationPolicy.Decision decideNavigation(String url) {
        // 只有正在显示远程时才把远程 origin 交给策略。看本机页面时不传 ——
        // 否则页面上一个指向那台电脑的链接会静默切换「在看哪台机器」。
        String origin = remoteActive && remoteTarget != null ? remoteTarget.origin() : null;
        int localPort = eacTarget == null
            ? PaseoPortConfig.normalize(paseoPort) : eacTarget.port();
        return PaseoNavigationPolicy.decideWithRemote(url, localPort, origin);
    }

    /**
     * Native Android capabilities are only available to the local Paseo page.
     *
     * <p>The same WebView is reused for the optional remote computer connection. A
     * JavascriptInterface has no origin information of its own, so checking the
     * current navigation state is the security boundary here.
     */
    private boolean isLocalWebViewPage(String url) {
        if (remoteActive || webView == null || url == null || url.trim().isEmpty()) return false;
        return decideNavigation(url) == PaseoNavigationPolicy.Decision.ALLOW_LOCAL;
    }

    private boolean isLocalBridgeAllowed() {
        return webView != null && isLocalWebViewPage(webView.getUrl());
    }

    private void renderControlState(EacControlState state) {
        controlState = state;
        runState.setText(phaseLabel(state.phase()));
        status.setText(state.message());
        busy.setVisibility(state.showProgress() ? View.VISIBLE : View.GONE);

        boolean running = state.phase() == EacControlState.Phase.RUNNING;
        startButton.setText(running ? R.string.paseo_action_enter : R.string.paseo_action_start);
        startButton.setEnabled(state.canStart() || state.canEnter());
        restartButton.setEnabled(state.canRestart());
        stopButton.setEnabled(state.canStop());

        int dotColor;
        switch (state.phase()) {
            case RUNNING:
                dotColor = R.color.paseo_dsha_ok;
                break;
            case ERROR:
                dotColor = R.color.paseo_dsha_err;
                break;
            case PREPARING:
            case STARTING:
                dotColor = R.color.paseo_dsha_warn;
                break;
            case STOPPED:
            default:
                dotColor = R.color.paseo_dsha_text_muted;
                break;
        }
        runDot.setTextColor(getColor(dotColor));

        if (state.endpoint() == null) {
            endpoint.setVisibility(View.GONE);
            endpoint.setText("");
        } else {
            endpoint.setText(getString(R.string.paseo_endpoint_format, state.endpoint()));
            endpoint.setVisibility(View.VISIBLE);
        }
    }

    private int phaseLabel(EacControlState.Phase phase) {
        switch (phase) {
            case PREPARING:
                return R.string.paseo_state_preparing;
            case STARTING:
                return R.string.paseo_state_starting;
            case RUNNING:
                return R.string.paseo_state_running;
            case ERROR:
                return R.string.paseo_state_error;
            case STOPPED:
            default:
                return R.string.paseo_state_stopped;
        }
    }

    private void showWebView() {
        if (!controlState.canEnter() || webView == null) return;

        // 本机入口:即使地址还记着,这一屏显示的也是本机。
        remoteActive = false;
        String url;
        if (eacTarget == null) {
            url = PaseoPortConfig.homeUrl(paseoPort);
        } else {
            url = initialEacUrlPending ? eacTarget.initialUrl()
                : eacTarget.homeUrl();
            initialEacUrlPending = false;
        }
        homePane.setVisibility(View.GONE);
        webPane.setVisibility(View.VISIBLE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(url);
    }

    private void showControlPanel() {
        if (webView != null) webView.setVisibility(View.GONE);
        if (webPane != null) webPane.setVisibility(View.GONE);
        if (homePane != null) homePane.setVisibility(View.VISIBLE);
    }

    private void copyLocalAddress() {
        String address = controlState.endpoint();
        if (address == null) return;
        ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText(
                getString(R.string.paseo_endpoint_label), address));
            Toast.makeText(this, R.string.paseo_address_copied, Toast.LENGTH_SHORT).show();
        }
    }

    private void recordSidecarLog(String message) {
        if (message == null || message.trim().isEmpty()) return;
        synchronized (sidecarLogLock) {
            if (sidecarLog.length() > 0) sidecarLog.append('\n');
            sidecarLog.append(message.trim());
            if (sidecarLog.length() > EAC_LOG_MAX_BYTES) {
                sidecarLog.delete(0, sidecarLog.length() - EAC_LOG_MAX_BYTES);
            }
        }
        refreshEacLog();
    }

    private String sidecarLogSnapshot() {
        synchronized (sidecarLogLock) {
            return sidecarLog.toString();
        }
    }

    private void refreshEacLog() {
        final long generation = ++logRefreshGeneration;
        EAC_LIFECYCLE_EXECUTOR.execute(() -> {
            String webLog = "";
            String readError = "";
            try {
                webLog = EacLogTail.read(
                    EacLogTail.webLogFile(getFilesDir()), EAC_LOG_MAX_BYTES);
            } catch (IOException error) {
                readError = messageFor(error);
            }
            String sidecar = sidecarLogSnapshot();
            StringBuilder combined = new StringBuilder();
            if (!sidecar.isEmpty()) combined.append("[sidecar]\n").append(sidecar);
            if (!webLog.isEmpty()) {
                if (combined.length() > 0) combined.append("\n\n");
                combined.append("[dsh-web.log]\n").append(webLog);
            }
            if (!readError.isEmpty()) {
                if (combined.length() > 0) combined.append("\n\n");
                combined.append("[log] ").append(readError);
            }
            final String display = combined.toString();
            runOnUiThread(() -> {
                if (generation != logRefreshGeneration || logText == null) return;
                logText.setText(display.isEmpty()
                    ? getString(R.string.paseo_logs_empty) : display);
                logScroll.post(() -> logScroll.fullScroll(View.FOCUS_DOWN));
            });
        });
    }

    private void configureWebView() {
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        webView.setWebChromeClient(new PaseoWebChromeClient());
        webView.setWebViewClient(new PaseoWebViewClient());
        CookieManager.getInstance().setAcceptCookie(true);
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
        Log.i(TAG, "Directory result: code=" + resultCode + " uri=" + (data == null ? null : data.getData()));
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
        Log.i(TAG, "Directory path resolved: " + path + " permission=" + hasStoragePermission());
        if (path == null) {
            dispatchDirectoryResult("这个目录由系统提供商管理，无法转换成 Paseo 可访问的本地路径。", null, treeUri.toString());
            return;
        }
        if (path.startsWith("/storage/") && !hasStoragePermission()) {
            // SAF 的授权只覆盖 content URI;runtime 里的 node 走的是真实文件系统路径,
            // 必须另有 WRITE_EXTERNAL_STORAGE 才能读写共享存储。
            pendingDirectoryPath = path;
            pendingDirectoryUri = treeUri.toString();
            requestStoragePermissionIfNeeded();
            return;
        }
        dispatchDirectoryResult(null, path, treeUri.toString());
    }

    @Override
    public void onRequestPermissionsResult(
        int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != STORAGE_PERMISSION_REQUEST || pendingDirectoryPath == null) return;
        String path = pendingDirectoryPath;
        String uri = pendingDirectoryUri;
        pendingDirectoryPath = null;
        pendingDirectoryUri = null;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            dispatchDirectoryResult(null, path, uri);
            return;
        }
        dispatchDirectoryResult(
            "没有手机存储权限，无法使用这个目录。请在系统设置里授予存储权限后重试。", null, uri);
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
        runOnUiThread(() -> {
            if (!isLocalBridgeAllowed() || webView == null) return;
            webView.evaluateJavascript(script, null);
        });
    }

    @Override
    public void onState(PaseoRuntimeState state) {
        runOnUiThread(() -> {
            // READY 只把控制页切成"可进入",不自动跳进 WebView —— 进入由用户点按钮触发,
            // 这样 initialUrl() 的一次性 token 不会被后台状态刷新烧掉。
            renderControlState(toControlState(state));
            showControlPanel();
        });
    }

    private EacControlState toControlState(PaseoRuntimeState state) {
        switch (state.phase()) {
            case READY:
                return EacControlState.running(state.message(), homeUrl());
            case STARTING:
                return EacControlState.starting(state.message());
            case ERROR:
                return EacControlState.error(state.message());
            case INSTALLING:
            case PATCHING:
            default:
                return EacControlState.preparing(state.message());
        }
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
            runOnUiThread(() -> {
                if (isLocalBridgeAllowed()) launchDirectoryPicker();
            });
        }

        @JavascriptInterface
        public void openTermuxTerminal() {
            runOnUiThread(() -> {
                if (!isLocalBridgeAllowed()) return;
                Log.i(TAG, "WebView requested native Termux terminal");
                launchTermuxActivity();
            });
        }

        @JavascriptInterface
        public void changePaseoPort() {
            runOnUiThread(() -> {
                if (isLocalBridgeAllowed()) showPortDialog();
            });
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
        PaseoNavigationPolicy.Decision decision = decideNavigation(url);
        if (decision == PaseoNavigationPolicy.Decision.ALLOW_LOCAL ||
            decision == PaseoNavigationPolicy.Decision.ALLOW_REMOTE) {
            return false;
        }
        if (decision == PaseoNavigationPolicy.Decision.OPEN_HOME) {
            view.loadUrl(homeUrl());
        } else if (decision == PaseoNavigationPolicy.Decision.OPEN_EXTERNAL) {
            openExternalUrl(url);
        }
        return true;
    }

    private void handlePopupNavigation(WebView popup, String url) {
        PaseoNavigationPolicy.Decision decision = decideNavigation(url);
        if (decision == PaseoNavigationPolicy.Decision.ALLOW_LOCAL ||
            decision == PaseoNavigationPolicy.Decision.ALLOW_REMOTE) {
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
    protected void onPause() {
        super.onPause();
        // token 只能用一次,之后靠 auth cookie。不落盘的话进程一死 cookie 就没了,
        // 下次点「电脑 · host:port」直接 401 —— 而那时手上已经没有可用的 token 了。
        CookieManager.getInstance().flush();
    }

    @Override
    public void onBackPressed() {
        // WebView 可见时返回键回控制页,不走 goBack() —— 控制页是这个 Activity 的根,
        // 页内历史交给 EAC Web UI 自己管。
        if (webView != null && webView.getVisibility() == View.VISIBLE) {
            showControlPanel();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        stopEacClient();
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

        @Override
        public boolean onConsoleMessage(android.webkit.ConsoleMessage consoleMessage) {
            // EAC 前端的 console 默认全丢黑洞;转发到 logcat 才能诊断注入的 shim 和页面报错。
            Log.d("PaseoWeb", consoleMessage.lineNumber() + ": " + consoleMessage.message());
            return true;
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

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            if (!isLocalWebViewPage(url)) return;
            // 插件市场按 navigator.language 选中英文,而那是模块级常量,实测在 2ms 就读完了 ——
            // onPageFinished 已经太晚。语言取自 EAC 自己的 settings.yaml,读不到就不注入。
            // 详见 PaseoLocaleShim。
            String script = PaseoLocaleShim.injectionScript(
                PaseoLocaleShim.preferredLanguage(PaseoHome.directory(getFilesDir())));
            if (!script.isEmpty()) view.evaluateJavascript(script, null);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (!isLocalWebViewPage(url)) return;
            // EAC 的设置面板在 412px 上会被裁掉两侧、标签也被压没,详见 PaseoMobileCss。
            // 按 id 复用节点,所以首屏和 token 重定向后各注入一次都没有副作用。
            view.evaluateJavascript(PaseoMobileCss.injectionScript(), null);
            // 系统时区是 POSIX 别名时,Chromium 会把 Intl 的时区退化成 "+00:00",
            // 服务端拒收,发消息 100% 失败。详见 PaseoTimeZoneShim。
            view.evaluateJavascript(
                PaseoTimeZoneShim.injectionScript(PaseoTimeZoneShim.currentZone()), null);
            // 插件的浮层大多是 hover 驱动的,触屏只有「进」没有「出」,打开就关不掉。
            // 详见 PaseoTouchShim。自带幂等标记,重复注入无副作用。
            view.evaluateJavascript(PaseoTouchShim.injectionScript(), null);
            // EAC 的某些对话框在校验失败时阻止关闭,点外部无效。详见 PaseoDialogShim。
            view.evaluateJavascript(PaseoDialogShim.injectionScript(), null);
            // 「添加工作区」接到系统文件管理器(SAF)。详见 PaseoWorkspacePickerShim。
            view.evaluateJavascript(PaseoWorkspacePickerShim.injectionScript(), null);
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
