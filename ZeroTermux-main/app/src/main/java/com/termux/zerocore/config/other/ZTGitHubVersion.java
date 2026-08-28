package com.termux.zerocore.config.other;

import android.view.View;
import android.widget.TextView;

import com.example.xh_lib.utils.LogUtils;
import com.example.xh_lib.utils.UUtils;

/**
 * Upstream ZeroTermux polled its own GitHub releases to light up a "NEW" badge in the
 * drawer. Paseo is a separate product and does not ship from that repository, so the check
 * only produced startup network traffic and a stream of 403/limit errors in logcat while
 * comparing Paseo's version against an unrelated project's tags.
 *
 * <p>The badge is now permanently hidden. The class and method are kept so the two
 * TermuxActivity call sites stay untouched; if Paseo ever gains its own update feed, this
 * is where it goes.
 */
public class ZTGitHubVersion {
    private static final String TAG = ZTGitHubVersion.class.getSimpleName();

    public static ZTGitHubVersion create() {
        return new ZTGitHubVersion();
    }

    /** Hides the badge. Paseo has no upstream release feed to compare against. */
    public void initZtVersionVisible(TextView textView) {
        setVisible(textView, false);
    }

    private static void setVisible(TextView textView, boolean visible) {
        if (textView == null) {
            return;
        }
        try {
            UUtils.runOnUIThread(() -> {
                try {
                    textView.setVisibility(visible ? View.VISIBLE : View.GONE);
                } catch (Throwable t) {
                    LogUtils.e(TAG, "setVisible ui failed: " + t);
                }
            });
        } catch (Throwable t) {
            try {
                textView.setVisibility(visible ? View.VISIBLE : View.GONE);
            } catch (Throwable ignored) {
            }
        }
    }
}
