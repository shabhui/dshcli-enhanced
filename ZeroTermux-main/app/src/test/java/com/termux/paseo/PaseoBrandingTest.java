package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Test;

/**
 * 应用名与启动器图标必须与上游 DSHA 一致。
 *
 * <p>这些断言拦的都是编译期发现不了的错:名字散在三个 locale 里,漏一个就在那个语言下显示旧名;
 * 图标是矢量路径,绕向或缩放改错了照样编译通过,只在启动器上表现为整块反相、或圆形遮罩把
 * 鲸鱼头尾裁掉。
 */
public class PaseoBrandingTest {

    /** 与上游 {@code app/src/main/res/values/strings.xml} 一致。 */
    private static final String APP_NAME = "DSHA";

    /** 上游剪影色,PNG 调色板里占比最高的深色项。 */
    private static final String WHALE_COLOR = "#1B1B19";

    /** adaptive icon 的安全区:以画布中心为圆心、直径 66dp 的圆,遮罩不会裁到这里面。 */
    private static final double SAFE_ZONE_DIAMETER = 66.0;

    private static final String[] LOCALE_STRINGS = {
        "src/main/res/values/strings.xml",
        "src/main/res/values-en/strings.xml",
        "src/main/res/values-zh-rCN/strings.xml",
    };

    @Test
    public void everyLocaleShowsTheUpstreamAppName() throws Exception {
        for (String path : LOCALE_STRINGS) {
            String strings = read(new File(path));
            assertTrue(path + " 必须用上游的应用名",
                strings.contains("<string name=\"app_name\">" + APP_NAME + "</string>"));
            assertFalse(path + " 仍残留旧名", strings.contains("Paseo Enhanced"));
        }
    }

    @Test
    public void keepsTermuxOwnNameForItsOwnUiText() throws Exception {
        String sharedStrings = read(new File("../termux-shared/src/main/res/values/strings.xml"));

        // TERMUX_APP_NAME 出现在终端提示、通知与帮助文案里,指的是 Termux 本身而不是这个 App。
        // 跟着改会让 Termux 自己的文案错位,所以它刻意保持原值。
        assertTrue(sharedStrings.contains("<!ENTITY TERMUX_APP_NAME \"Termux\">"));
    }

    @Test
    public void launcherLabelResolvesThroughAppName() throws Exception {
        String manifest = read(new File("src/main/AndroidManifest.xml"));

        // 桌面图标的标签取 application 级的 label。写死字符串就绕过了上面的 locale 断言。
        assertTrue(manifest.contains("android:label=\"@string/app_name\""));
        assertFalse(manifest.contains("android:label=\"" + APP_NAME + "\""));
    }

    @Test
    public void adaptiveIconUsesTheWhaleLayers() throws Exception {
        for (String name : new String[] {"ic_launcher.xml", "ic_launcher_round.xml"}) {
            String icon = read(new File("src/main/res/mipmap-anydpi-v26/" + name));
            assertTrue(name + " 背景层", icon.contains("@drawable/paseo_launcher_background"));
            assertTrue(name + " 前景层", icon.contains("@drawable/paseo_launcher_foreground"));
        }
    }

    @Test
    public void whaleForegroundKeepsTheWindingItWasTracedWith() throws Exception {
        String foreground = read(new File("src/main/res/drawable/paseo_launcher_foreground.xml"));

        // 路径按「实心在右手侧」追踪,于是外轮廓顺时针、孔洞逆时针,靠 nonZero 挖孔。
        // 换成 evenOdd 或依赖默认值,鲸鱼身上的孔会填实或整块反相 —— 编译不报错。
        assertTrue("绕向是这段路径正确性的前提,fillType 必须显式写",
            foreground.contains("android:fillType=\"nonZero\""));
        assertTrue(foreground.contains("android:fillColor=\"" + WHALE_COLOR + "\""));
        assertFalse("不能改成 evenOdd", foreground.contains("evenOdd"));
    }

    @Test
    public void whaleFitsInsideTheAdaptiveIconSafeZone() throws Exception {
        String foreground = read(new File("src/main/res/drawable/paseo_launcher_foreground.xml"));
        double[] box = boundingBox(foreground);
        double width = box[2] - box[0];
        double height = box[3] - box[1];

        // 鲸鱼原始 bbox 宽 83.25,超出安全区;缩放居中后必须落回来,否则圆形或水滴遮罩裁掉头尾。
        assertTrue("鲸鱼宽 " + width + " 超出安全区", width <= SAFE_ZONE_DIAMETER);
        assertTrue("鲸鱼高 " + height + " 超出安全区", height <= SAFE_ZONE_DIAMETER);

        // 还要真的居中 —— 只缩不移一样会被裁。
        assertEquals("水平中心", 54.0, (box[0] + box[2]) / 2, 1.0);
        assertEquals("垂直中心", 54.0, (box[1] + box[3]) / 2, 1.0);
    }

    @Test
    public void legacyFallbackVectorCarriesItsOwnBackground() throws Exception {
        String fallback = read(new File("src/main/res/mipmap-anydpi/ic_launcher.xml"));

        // API 26 以下没有 adaptive 分层,背景不会自动铺上。少了这块,鲸鱼会画在透明底上,
        // 深色剪影落到深色壁纸上就看不见了。
        assertTrue("回退图标必须自带铺满画布的背景",
            fallback.contains("android:pathData=\"M0,0H108V108H0Z\""));
        assertTrue(fallback.contains("android:fillColor=\"" + WHALE_COLOR + "\""));
        assertTrue(fallback.contains("android:fillType=\"nonZero\""));
        assertFalse("旧品牌的绿色不该还在", fallback.contains("#38A269"));
    }

    @Test
    public void legacyDensityBucketsAllCarryTheUpstreamBitmap() throws Exception {
        // 五个密度桶都要有,且 round 与方版同源(上游的 roundIcon 就指向同一张)。
        // 漏掉一个桶,那个密度上 aapt 会拉邻近桶缩放,图标会糊。
        long expected = -1;
        for (String density : new String[] {"mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"}) {
            File square = new File("src/main/res/mipmap-" + density + "/ic_launcher.png");
            File round = new File("src/main/res/mipmap-" + density + "/ic_launcher_round.png");
            assertTrue(square + " 缺失", square.isFile());
            assertTrue(round + " 缺失", round.isFile());
            assertEquals(density + " 的 round 与方版必须同源",
                square.length(), round.length());
            assertTrue(density + " 的图标为空", square.length() > 0);
            assertTrue(density + " 与更低密度重复,说明没按桶生成",
                square.length() != expected);
            expected = square.length();
        }
    }

    /** 从矢量 XML 的所有 {@code pathData} 里取整体包围盒,返回 {@code {x0, y0, x1, y1}}。 */
    private static double[] boundingBox(String vectorXml) {
        double x0 = Double.MAX_VALUE, y0 = Double.MAX_VALUE;
        double x1 = -Double.MAX_VALUE, y1 = -Double.MAX_VALUE;
        java.util.regex.Matcher m = java.util.regex.Pattern
            .compile("(-?\\d+\\.\\d+),(-?\\d+\\.\\d+)")
            .matcher(vectorXml);
        int points = 0;
        while (m.find()) {
            double x = Double.parseDouble(m.group(1));
            double y = Double.parseDouble(m.group(2));
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
            points++;
        }
        assertTrue("取不到坐标点,断言就没有意义", points > 100);
        return new double[] {x0, y0, x1, y1};
    }

    private static String read(File file) throws Exception {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }
}
