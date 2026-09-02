package com.termux.paseo;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;

/** Resolves and reads the bounded tail of EAC's dsh web log without Android dependencies. */
public final class EacLogTail {
    private static final String WEB_LOG_RELATIVE_PATH =
        ".config/deepseek-harness-eac/logs/dsh-web.log";

    private EacLogTail() {}

    public static File webLogFile(File filesDirectory) {
        return new File(PaseoHome.directory(filesDirectory), WEB_LOG_RELATIVE_PATH);
    }

    public static String read(File file, int maxBytes) throws IOException {
        if (maxBytes <= 0) throw new IllegalArgumentException("maxBytes must be positive");
        if (file == null || !file.isFile()) return "";

        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            return readTail(input, input.length(), maxBytes);
        }
    }

    /**
     * Reads the last {@code maxBytes} of an already-open log, tolerating a file that shrank
     * since {@code length} was sampled.
     *
     * <p>dsh web 会在运行中轮转自己的日志,长度快照和实际读取之间盘上的字节数可能变少,
     * 所以这里尽力读取、按实到长度构造字符串,而不是 readFully 抛 EOF 把刷新日志变成崩溃。
     * 长度由调用方传入,单元测试才能把这个竞态钉成确定性用例。
     */
    static String readTail(RandomAccessFile input, long length, int maxBytes) throws IOException {
        long start = Math.max(0L, length - maxBytes);
        int size = (int) Math.min(Integer.MAX_VALUE, length - start);
        if (size <= 0) return "";

        byte[] buffer = new byte[size];
        input.seek(start);
        int filled = 0;
        while (filled < buffer.length) {
            int read = input.read(buffer, filled, buffer.length - filled);
            if (read < 0) break;
            filled += read;
        }
        if (filled <= 0) return "";

        int offset = 0;
        if (start > 0) {
            while (offset < filled && buffer[offset] != '\n') offset++;
            if (offset < filled) offset++;
            else offset = 0;
        }
        return new String(buffer, offset, filled - offset, StandardCharsets.UTF_8);
    }
}
