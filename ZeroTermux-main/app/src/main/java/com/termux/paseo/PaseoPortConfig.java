package com.termux.paseo;

final class PaseoPortConfig {
    static final int DEFAULT_PORT = 6767;
    static final int CODEX_PROXY_PORT = 6768;

    private PaseoPortConfig() {}

    static int normalize(int port) {
        return port >= 1024 && port <= 65535 && port != CODEX_PROXY_PORT
            ? port : DEFAULT_PORT;
    }

    static boolean isValid(String value) {
        if (value == null) return false;
        try {
            int port = Integer.parseInt(value.trim());
            return port >= 1024 && port <= 65535 && port != CODEX_PROXY_PORT;
        } catch (NumberFormatException error) {
            return false;
        }
    }

    static int parse(String value) {
        if (!isValid(value)) return DEFAULT_PORT;
        return Integer.parseInt(value.trim());
    }

    static String homeUrl(int port) {
        return "http://127.0.0.1:" + normalize(port) + "/";
    }
}
