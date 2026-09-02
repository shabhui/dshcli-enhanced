package com.termux.paseo;

/** Immutable view state for the native EAC lifecycle controls. */
public final class EacControlState {
    public enum Phase {
        PREPARING,
        STARTING,
        RUNNING,
        STOPPED,
        ERROR
    }

    private static final String FALLBACK_MESSAGE = "EAC status is unavailable";

    private final Phase phase;
    private final String message;
    private final String endpoint;

    private EacControlState(Phase phase, String message, String endpoint) {
        this.phase = phase;
        this.message = normalized(message, FALLBACK_MESSAGE);
        this.endpoint = normalized(endpoint, null);
    }

    public static EacControlState preparing(String message) {
        return new EacControlState(Phase.PREPARING, message, null);
    }

    public static EacControlState starting(String message) {
        return new EacControlState(Phase.STARTING, message, null);
    }

    public static EacControlState running(String message, String endpoint) {
        return new EacControlState(Phase.RUNNING, message, endpoint);
    }

    public static EacControlState stopped(String message) {
        return new EacControlState(Phase.STOPPED, message, null);
    }

    public static EacControlState error(String message) {
        return new EacControlState(Phase.ERROR, message, null);
    }

    public Phase phase() {
        return phase;
    }

    public String message() {
        return message;
    }

    public String endpoint() {
        return endpoint;
    }

    public boolean showProgress() {
        return phase == Phase.PREPARING || phase == Phase.STARTING;
    }

    public boolean canStart() {
        return phase == Phase.STOPPED || phase == Phase.ERROR;
    }

    public boolean canEnter() {
        return phase == Phase.RUNNING;
    }

    public boolean canRestart() {
        return phase == Phase.RUNNING;
    }

    public boolean canStop() {
        return phase == Phase.PREPARING || phase == Phase.STARTING || phase == Phase.RUNNING;
    }

    private static String normalized(String value, String fallback) {
        if (value == null) return fallback;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? fallback : trimmed;
    }
}
