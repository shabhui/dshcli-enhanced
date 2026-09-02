package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ResolveInfo;
import android.net.Uri;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class PaseoDirectoryChooserTest {
    @Test
    public void createsPersistableDirectoryTreeIntent() {
        Intent intent = PaseoDirectoryChooser.createIntent();

        assertEquals(Intent.ACTION_OPEN_DOCUMENT_TREE, intent.getAction());
        assertTrue((intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);
        assertTrue((intent.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0);
        assertTrue((intent.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0);
    }

    @Test
    public void chooserAlwaysLaunchesTheSystemDirectoryTreePicker() {
        Intent chooser = PaseoDirectoryChooser.createChooserIntent("选择工作区文件夹");

        assertEquals(Intent.ACTION_OPEN_DOCUMENT_TREE, chooser.getAction());
        assertEquals("选择工作区文件夹", chooser.getStringExtra(Intent.EXTRA_TITLE));
    }

    @Test
    public void chooserDoesNotOfferFileOnlyThirdPartyIntents() {
        ResolveInfo handler = new ResolveInfo();
        handler.activityInfo = new ActivityInfo();
        handler.activityInfo.packageName = "com.example.files";
        handler.activityInfo.name = "com.example.files.PickerActivity";
        Intent fileOnlyIntent = new Intent(Intent.ACTION_GET_CONTENT);
        fileOnlyIntent.setType("*/*");
        fileOnlyIntent.addCategory(Intent.CATEGORY_OPENABLE);
        shadowOf(RuntimeEnvironment.getApplication().getPackageManager())
            .addResolveInfoForIntent(fileOnlyIntent, handler);

        Intent chooser = PaseoDirectoryChooser.createChooserIntent(
            RuntimeEnvironment.getApplication(), "选择工作区文件夹");

        assertEquals(Intent.ACTION_OPEN_DOCUMENT_TREE, chooser.getAction());
        assertNull(chooser.getParcelableArrayExtra(Intent.EXTRA_INITIAL_INTENTS));
    }

    @Test
    public void mapsPaseoPrivateHomeDocumentUrisToLocalPaths() {
        Uri root = Uri.parse(
            "content://com.dshcli.documents/tree/%2Fdata%2Fdata%2Fcom.dshcli%2Ffiles%2Fhome");
        Uri project = Uri.parse(
            "content://com.dshcli.documents/tree/%2Fdata%2Fdata%2Fcom.dshcli%2Ffiles%2Fhome%2Fproject");

        assertEquals("/data/data/com.dshcli/files/home", PaseoDirectoryChooser.toFilesystemPath(root));
        assertEquals("/data/data/com.dshcli/files/home/project", PaseoDirectoryChooser.toFilesystemPath(project));
    }

    @Test
    public void rejectsPaseoProviderUrisOutsideItsPrivateHome() {
        assertNull(PaseoDirectoryChooser.toFilesystemPath(Uri.parse(
            "content://com.dshcli.documents/tree/%2Fdata%2Fdata%2Fcom.dshcli%2Ffiles%2Fusr")));
        assertNull(PaseoDirectoryChooser.toFilesystemPath(Uri.parse(
            "content://com.dshcli.documents/tree/%2Fdata%2Fdata%2Fcom.dshcli%2Ffiles%2Fhome%2F..%2Fusr")));
    }

    @Test
    public void mapsPrimaryExternalStorageDocumentUrisToNodePaths() {
        Uri uri = Uri.parse("content://com.android.externalstorage.documents/tree/primary%3ADownload%2Fdemo");

        assertEquals("/storage/emulated/0/Download/demo", PaseoDirectoryChooser.toFilesystemPath(uri));
    }

    @Test
    public void mapsNamedExternalStorageVolumesToStoragePaths() {
        Uri uri = Uri.parse("content://com.android.externalstorage.documents/tree/1234-ABCD%3AProjects");

        assertEquals("/storage/1234-ABCD/Projects", PaseoDirectoryChooser.toFilesystemPath(uri));
    }

    @Test
    public void preservesPlusCharactersInDirectoryNames() {
        Uri uri = Uri.parse("content://com.android.externalstorage.documents/tree/primary%3AC%2B%2B%2Fdemo%2Bworkspace");

        assertEquals("/storage/emulated/0/C++/demo+workspace", PaseoDirectoryChooser.toFilesystemPath(uri));
    }

    @Test
    public void rejectsUnsafeExternalStorageDocumentUris() {
        assertNull(PaseoDirectoryChooser.toFilesystemPath(Uri.parse(
            "content://com.android.externalstorage.documents/tree/primary%3AProjects%2F..%2FSecrets")));
        assertNull(PaseoDirectoryChooser.toFilesystemPath(Uri.parse(
            "content://com.android.externalstorage.documents/tree/primary%3AProjects%2Fdemo%2500workspace")));
    }

    @Test
    public void acceptsSafeExternalStorageFileUris() {
        Uri uri = Uri.parse("file:///storage/emulated/0/Projects/demo%2Bworkspace");

        assertEquals("/storage/emulated/0/Projects/demo+workspace", PaseoDirectoryChooser.toFilesystemPath(uri));
    }

    @Test
    public void rejectsUnsafeFileUris() {
        assertNull(PaseoDirectoryChooser.toFilesystemPath(Uri.parse("file:///data/user/0/com.dshcli/files")));
        assertNull(PaseoDirectoryChooser.toFilesystemPath(Uri.parse("file:///storage/emulated/0/Projects/../Secrets")));
        assertNull(PaseoDirectoryChooser.toFilesystemPath(Uri.parse("file://remote/storage/emulated/0/Projects")));
    }
}
