package com.termux.paseo;

import java.io.File;
import java.util.Map;

final class PaseoProcessEnvironment {
    private PaseoProcessEnvironment() {}

    static void apply(Map<String, String> environment, File filesDirectory) {
        // Unified with the Termux session HOME; see PaseoHome.
        File home = PaseoHome.directory(filesDirectory);
        File prefix = new File(filesDirectory, "usr");
        File temporary = new File(prefix, "tmp");

        environment.remove("LD_PRELOAD");
        environment.remove("LD_LIBRARY_PATH");
        environment.put("HOME", home.getAbsolutePath());
        environment.put("PREFIX", prefix.getAbsolutePath());
        environment.put("TMPDIR", temporary.getAbsolutePath());
        environment.put("PATH", new File(prefix, "bin").getAbsolutePath() +
            ":/system/bin:/system/xbin");

        // Node/OpenSSL 在这个前缀里默认去 <prefix>/etc/tls/certs 找证书,而 Termux
        // bootstrap 只发 etc/tls/cert.pem,那个目录不存在 —— 每次启动都会打印
        // 「Cannot open directory ... to load OpenSSL certificates.」并且 HTTPS 退回
        // 内置证书。指到 bootstrap 真正带的这一份即可,顺带让 apt/dpkg 与 CLI 也一致。
        // 只在证书文件真的存在时才设置:指向不存在的文件会让 OpenSSL 比默认更糟。
        File certificateBundle = new File(prefix, "etc/tls/cert.pem");
        if (certificateBundle.isFile()) {
            environment.put("SSL_CERT_FILE", certificateBundle.getAbsolutePath());
            environment.put("SSL_CERT_DIR", new File(prefix, "etc/tls").getAbsolutePath());
        }
    }
}
