package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class PaseoProcessEnvironmentTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void createsAnAppOwnedRuntimeEnvironmentWithoutTermuxExec() {
        Map<String, String> inherited = new LinkedHashMap<>();
        inherited.put("LD_PRELOAD", "/data/data/com.dshcli/files/usr/lib/libtermux-exec.so");
        inherited.put("LD_LIBRARY_PATH", "/data/data/com.termux/files/usr/lib");
        inherited.put("ANDROID_ROOT", "/system");

        File filesDirectory = new File("/data/user/0/com.dshcli/files");
        PaseoProcessEnvironment.apply(inherited, filesDirectory);

        assertFalse(inherited.containsKey("LD_PRELOAD"));
        assertFalse(inherited.containsKey("LD_LIBRARY_PATH"));
        // Unified with the Termux session HOME (TermuxConstants.TERMUX_HOME_DIR_PATH).
        assertEquals(new File(filesDirectory, "home").getAbsolutePath(), inherited.get("HOME"));
        assertEquals(new File(filesDirectory, "usr").getAbsolutePath(), inherited.get("PREFIX"));
        assertTrue(inherited.get("PATH").startsWith(
            new File(filesDirectory, "usr/bin").getAbsolutePath()));
        assertEquals("/system", inherited.get("ANDROID_ROOT"));
    }

    @Test
    public void pointsOpenSslAtTheTermuxCertificateBundle() throws IOException {
        // bootstrap 只发 etc/tls/cert.pem;Node 默认找的 etc/tls/certs 根本不存在,
        // 于是启动时报「Cannot open directory ... to load OpenSSL certificates.」。
        File root = temporaryFolder.newFolder("files");
        File tls = new File(new File(root, "usr"), "etc/tls");
        assertTrue(tls.mkdirs());
        File bundle = new File(tls, "cert.pem");
        assertTrue(bundle.createNewFile());

        Map<String, String> environment = new LinkedHashMap<>();
        PaseoProcessEnvironment.apply(environment, root);

        assertEquals(bundle.getAbsolutePath(), environment.get("SSL_CERT_FILE"));
        assertEquals(tls.getAbsolutePath(), environment.get("SSL_CERT_DIR"));
    }

    @Test
    public void leavesOpenSslAloneUntilTheCertificateBundleExists() throws IOException {
        // 运行时还没装好时不能指向不存在的文件,否则 OpenSSL 比用默认值更糟。
        File root = temporaryFolder.newFolder("files-without-certificates");

        Map<String, String> environment = new LinkedHashMap<>();
        PaseoProcessEnvironment.apply(environment, root);

        assertFalse(environment.containsKey("SSL_CERT_FILE"));
        assertFalse(environment.containsKey("SSL_CERT_DIR"));
    }
}
