package com.termux.paseo;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;

import com.termux.BuildConfig;
import com.termux.shared.termux.TermuxConstants;

final class PaseoDirectoryChooser {
    private static final String EXTERNAL_STORAGE_AUTHORITY =
        "com.android.externalstorage.documents";
    private static final String PASEO_DOCUMENTS_AUTHORITY =
        BuildConfig.APPLICATION_ID + ".documents";

    private PaseoDirectoryChooser() {}

    static Intent createIntent() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        if (Build.VERSION.SDK_INT >= 26) {
            intent.putExtra("android.content.extra.SHOW_ADVANCED", true);
            try {
                // 让选择器直接落在内部存储根,免得在 SAF 抽屉里先翻存储卷。
                intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI,
                    DocumentsContract.buildRootUri(EXTERNAL_STORAGE_AUTHORITY, "primary"));
            } catch (RuntimeException ignored) {
                // 个别 ROM 的 DocumentsUI 不认 initial URI;忽略后仍从默认位置打开。
            }
        }
        return intent;
    }

    static Intent createChooserIntent(String title) {
        return createChooserIntent(null, title);
    }

    static Intent createChooserIntent(Context context, String title) {
        Intent intent = createIntent();
        intent.putExtra(Intent.EXTRA_TITLE, title);
        return intent;
    }

    static String toFilesystemPath(Uri treeUri) {
        if (treeUri != null && "file".equalsIgnoreCase(treeUri.getScheme())) {
            if (treeUri.getAuthority() != null && !treeUri.getAuthority().isEmpty()) return null;
            return normalizeExternalPath(treeUri.getPath());
        }
        if (treeUri == null) {
            return null;
        }
        final String documentId;
        try {
            documentId = DocumentsContract.getTreeDocumentId(treeUri);
        } catch (RuntimeException error) {
            return null;
        }
        if (documentId == null || documentId.isEmpty()) return null;

        if (PASEO_DOCUMENTS_AUTHORITY.equals(treeUri.getAuthority())) {
            String privatePath = decode(documentId);
            String privateHome = TermuxConstants.TERMUX_HOME_DIR_PATH;
            if (privatePath == null || privatePath.indexOf('\0') >= 0 || containsTraversal(privatePath)) {
                return null;
            }
            return privatePath.equals(privateHome) || privatePath.startsWith(privateHome + "/")
                ? privatePath
                : null;
        }
        if (!EXTERNAL_STORAGE_AUTHORITY.equals(treeUri.getAuthority())) return null;

        int separator = documentId.indexOf(':');
        if (separator <= 0) return null;
        String volume = decode(documentId.substring(0, separator));
        String relative = decode(documentId.substring(separator + 1));
        if (volume == null || relative == null || !volume.matches("[A-Za-z0-9._-]+") ||
            relative.indexOf('\0') >= 0 || containsTraversal(relative)) return null;

        String base = "primary".equalsIgnoreCase(volume)
            ? "/storage/emulated/0"
            : "/storage/" + volume;
        if (relative.isEmpty()) return base;
        while (relative.startsWith("/")) relative = relative.substring(1);
        return base + "/" + relative;
    }

    private static String decode(String value) {
        return Uri.decode(value);
    }

    private static boolean containsTraversal(String value) {
        if (value.indexOf('\\') >= 0) return true;
        for (String segment : value.split("/", -1)) {
            if ("..".equals(segment)) return true;
        }
        return false;
    }

    private static String normalizeExternalPath(String value) {
        if (value == null || value.isEmpty() || value.indexOf('\0') >= 0 || containsTraversal(value)) {
            return null;
        }
        String path = value.replaceAll("/{2,}", "/");
        if (!(path.equals("/storage") || path.startsWith("/storage/") ||
            path.equals("/sdcard") || path.startsWith("/sdcard/"))) {
            return null;
        }
        return path;
    }
}
