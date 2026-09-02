package com.termux.paseo;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.Assert.assertEquals;

import java.io.File;
import java.io.RandomAccessFile;
import java.nio.file.Files;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class EacLogTailTest {

    @Rule
    public final TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void resolvesTheDesktopEacWebLogInsideTheSharedHome() throws Exception {
        File filesDirectory = temporary.newFolder("files");

        assertEquals(
            new File(filesDirectory, "home/.config/deepseek-harness-eac/logs/dsh-web.log"),
            EacLogTail.webLogFile(filesDirectory));
    }

    @Test
    public void returnsEmptyTextWhenTheLogDoesNotExist() throws Exception {
        assertEquals("", EacLogTail.read(new File(temporary.getRoot(), "missing.log"), 1024));
    }

    @Test
    public void readsTheWholeSmallLogAsUtf8() throws Exception {
        File log = temporary.newFile("small.log");
        Files.write(log.toPath(), "启动中\nready\n".getBytes(UTF_8));

        assertEquals("启动中\nready\n", EacLogTail.read(log, 1024));
    }

    @Test
    public void dropsThePartialFirstLineWhenReadingABoundedTail() throws Exception {
        File log = temporary.newFile("bounded.log");
        Files.write(log.toPath(),
            "old-one\nold-two\nnew-one\nnew-two\n".getBytes(UTF_8));

        assertEquals("new-one\nnew-two\n", EacLogTail.read(log, 18));
    }

    // 以下三例重放同一个竞态:dsh web 在我们取到长度之后轮转了日志,盘上的字节数比
    // 快照少。真机上这会把"刷新日志"变成一次 EOFException 崩溃,所以长度由调用方传入,
    // 用固定值把竞态钉成确定性用例。

    @Test
    public void readsWhatSurvivesWhenTheLogShrankAfterTheLengthSnapshot() throws Exception {
        File log = temporary.newFile("shrank.log");
        Files.write(log.toPath(), "kept\n".getBytes(UTF_8));

        try (RandomAccessFile input = new RandomAccessFile(log, "r")) {
            assertEquals("kept\n", EacLogTail.readTail(input, 4096L, 8192));
        }
    }

    @Test
    public void trimsThePartialFirstLineInsideWhatWasActuallyRead() throws Exception {
        File log = temporary.newFile("shrank-tail.log");
        StringBuilder text = new StringBuilder();
        for (int index = 0; index < 32; index++) text.append('o');
        text.append("xy\nkeep\n");
        Files.write(log.toPath(), text.toString().getBytes(UTF_8));

        // 快照 64 字节 → 从 32 起读 32 字节,但盘上只到 40,实际只读到 8 字节。
        // 截断首行必须在这 8 字节内进行,否则会拖出一片缓冲区里的 0。
        try (RandomAccessFile input = new RandomAccessFile(log, "r")) {
            assertEquals("keep\n", EacLogTail.readTail(input, 64L, 32));
        }
    }

    @Test
    public void returnsEmptyTextWhenTheWholeTailWindowIsPastTheEndOfTheFile() throws Exception {
        File log = temporary.newFile("rotated.log");
        Files.write(log.toPath(), "tiny\n".getBytes(UTF_8));

        try (RandomAccessFile input = new RandomAccessFile(log, "r")) {
            assertEquals("", EacLogTail.readTail(input, 4096L, 1024));
        }
    }
}
