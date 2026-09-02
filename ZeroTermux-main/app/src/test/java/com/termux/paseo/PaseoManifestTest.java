package com.termux.paseo;

import static org.junit.Assert.assertEquals;

import java.io.File;

import javax.xml.parsers.DocumentBuilderFactory;

import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

public class PaseoManifestTest {
    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";
    private static final String TOOLS_NS = "http://schemas.android.com/tools";

    @Test
    public void standaloneManifestDisablesBackupAndPermitsCleartextForLanComputers()
            throws Exception {
        Document manifest = parse(new File("src/main/AndroidManifest.xml"));
        Element application = (Element) manifest.getElementsByTagName("application").item(0);

        assertEquals("false", application.getAttributeNS(ANDROID_NS, "allowBackup"));
        assertEquals("@xml/network_security_config",
            application.getAttributeNS(ANDROID_NS, "networkSecurityConfig"));
        // manifest 上这个属性留着 false 是<b>无害</b>的:networkSecurityConfig 一旦存在就优先于它。
        // 真机验证过 —— 配置里放行某个 host 时请求确实发得出去,尽管这里写着 false。
        assertEquals("false", application.getAttributeNS(ANDROID_NS, "usesCleartextTraffic"));

        // 从「只放行回环」改成「全局放行」是为了「连接电脑」:电脑上的 DSH 默认是明文服务,
        // 而这个文件是编译期静态的,写不了网段。base-config 为 false 时请求在平台层就被丢掉,
        // 服务端收不到任何东西、logcat 不报错,用户只看到白屏。理由写在 xml 的注释里。
        Document networkConfig = parse(new File("src/main/res/xml/network_security_config.xml"));
        Element baseConfig = (Element) networkConfig.getElementsByTagName("base-config").item(0);
        assertEquals("true", baseConfig.getAttribute("cleartextTrafficPermitted"));
        // 全局放行之后 domain-config 就是死配置,留着只会让人以为还有范围限制。
        assertEquals(0, networkConfig.getElementsByTagName("domain-config").getLength());
    }

    // 启动器名字的断言集中在 PaseoBrandingTest —— 那里连「旧名不得残留」一起钉住,
    // 两处各写一份只会在改名时给出互相矛盾的结论。

    @Test
    public void onlyTheStandaloneLauncherRemainsPublicAmongLegacyEntryPoints() throws Exception {
        Document manifest = parse(new File("src/main/AndroidManifest.xml"));

        assertEquals("true", exported(manifest, "activity", ".paseo.PaseoActivity"));
        assertEquals("false", exported(manifest, "service", ".zerocore.settings.services.TimerExeService"));
        assertEquals("false", exported(manifest, "activity", ".zerocore.settings.TimerActivity"));
        assertEquals("false", exported(manifest, "activity", ".zerocore.guide.TermuxGuideActivity"));
        assertEquals("false", exported(manifest, "activity", ".app.TermuxActivity"));
        assertEquals("false", exported(manifest, "activity-alias", ".HomeActivity"));
        assertEquals("false", exported(manifest, "activity", ".app.activities.SettingsActivity"));
        assertEquals("false", exported(manifest, "service", ".zerocore.ftp.new_ftp.services.FtpService"));
        assertEquals("false", exported(manifest, "provider", ".app.TermuxOpenReceiver$ContentProvider"));
    }

    @Test
    public void usbDocumentProviderUsesTheStandaloneApplicationId() throws Exception {
        Document manifest = parse(new File("src/main/AndroidManifest.xml"));

        assertEquals("${applicationId}.usb.documents", attribute(
            manifest,
            "provider",
            "com.github.mjdev.libaums.storageprovider.UsbDocumentProvider",
            ANDROID_NS,
            "authorities"));
        assertEquals("android:authorities", attribute(
            manifest,
            "provider",
            "com.github.mjdev.libaums.storageprovider.UsbDocumentProvider",
            TOOLS_NS,
            "replace"));
    }

    private static String exported(Document document, String tag, String componentName) {
        return attribute(document, tag, componentName, ANDROID_NS, "exported");
    }

    private static String attribute(
        Document document, String tag, String componentName, String namespace, String attributeName) {
        NodeList nodes = document.getElementsByTagName(tag);
        for (int index = 0; index < nodes.getLength(); index++) {
            Element element = (Element) nodes.item(index);
            if (componentName.equals(element.getAttributeNS(ANDROID_NS, "name"))) {
                return element.getAttributeNS(namespace, attributeName);
            }
        }
        throw new AssertionError("Missing component " + componentName);
    }

    private static Document parse(File file) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        return factory.newDocumentBuilder().parse(file);
    }
}
