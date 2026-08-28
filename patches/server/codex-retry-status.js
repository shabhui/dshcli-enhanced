import { randomUUID } from "node:crypto";

const MAX_RESPONSE_BYTES = 4096;
const MAX_RESPONSE_CHARACTERS = 800;

let latestStatus = idleStatus();

function idleStatus() {
    return {
        requestId: null,
        active: false,
        phase: "idle",
        profileName: null,
        attempts: 0,
        reconnects: 0,
        maxAttempts: null,
        stage: null,
        endpoint: null,
        lastHttpStatus: null,
        lastFailure: null,
        stopReason: null,
        startedAt: null,
        updatedAt: null,
    };
}

function isCurrent(trace) {
    return Boolean(trace?.requestId) && latestStatus.requestId === trace.requestId;
}

function touch() {
    latestStatus.updatedAt = new Date().toISOString();
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function redactSensitiveText(value) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [redacted]")
        .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._~-]+\b/giu, "[redacted]");
}

export function summarizeUpstreamText(text) {
    const raw = typeof text === "string" ? text : String(text ?? "");
    let summary = raw;
    try {
        const payload = raw ? JSON.parse(raw) : null;
        summary = payload?.error?.message ?? payload?.message ?? payload?.detail ?? payload?.error ?? raw;
        if (typeof summary !== "string") summary = JSON.stringify(summary);
    }
    catch {
        // Plain-text upstream errors are already useful diagnostics.
    }
    return redactSensitiveText(String(summary || "(空响应)").replace(/\s+/gu, " ").trim()).slice(0, MAX_RESPONSE_CHARACTERS);
}

export async function summarizeUpstreamResponse(response) {
    try {
        const clone = response.clone();
        if (!clone.body?.getReader) return summarizeUpstreamText(await clone.text());
        const reader = clone.body.getReader();
        const chunks = [];
        let total = 0;
        while (total < MAX_RESPONSE_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = MAX_RESPONSE_BYTES - total;
            const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
            chunks.push(chunk);
            total += chunk.length;
            if (chunk.length < value.length) break;
        }
        await reader.cancel().catch(() => undefined);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return summarizeUpstreamText(new TextDecoder().decode(bytes));
    }
    catch {
        return "(无法读取上游响应)";
    }
}

export function beginCodexRetryTrace({ profileName } = {}) {
    const requestId = randomUUID();
    const now = new Date().toISOString();
    latestStatus = {
        ...idleStatus(),
        requestId,
        active: true,
        phase: "connecting",
        profileName: typeof profileName === "string" ? profileName : null,
        startedAt: now,
        updatedAt: now,
    };
    return { requestId };
}

export function recordCodexRetryAttempt(trace, { stage, endpoint, reconnect = false, maxAttempts } = {}) {
    if (!isCurrent(trace)) return;
    latestStatus.attempts += 1;
    if (reconnect) latestStatus.reconnects += 1;
    latestStatus.active = true;
    latestStatus.phase = reconnect ? "retrying" : "connecting";
    latestStatus.maxAttempts = Number.isInteger(maxAttempts) ? maxAttempts : latestStatus.maxAttempts;
    latestStatus.stage = stage || latestStatus.stage;
    latestStatus.endpoint = endpoint || latestStatus.endpoint;
    latestStatus.stopReason = null;
    touch();
}

export function recordCodexRetryHttpFailure(trace, { stage, endpoint, status, response, willRetry } = {}) {
    if (!isCurrent(trace)) return;
    latestStatus.phase = willRetry ? "retrying" : "failed";
    latestStatus.stage = stage || latestStatus.stage;
    latestStatus.endpoint = endpoint || latestStatus.endpoint;
    latestStatus.lastHttpStatus = Number.isInteger(status) ? status : null;
    latestStatus.lastFailure = {
        stage: latestStatus.stage,
        endpoint: latestStatus.endpoint,
        httpStatus: latestStatus.lastHttpStatus,
        response: response || "(空响应)",
        error: null,
        at: new Date().toISOString(),
    };
    touch();
}

export function recordCodexRetryNetworkFailure(trace, { stage, endpoint, error, willRetry } = {}) {
    if (!isCurrent(trace)) return;
    latestStatus.phase = willRetry ? "retrying" : "failed";
    latestStatus.stage = stage || latestStatus.stage;
    latestStatus.endpoint = endpoint || latestStatus.endpoint;
    latestStatus.lastHttpStatus = null;
    latestStatus.lastFailure = {
        stage: latestStatus.stage,
        endpoint: latestStatus.endpoint,
        httpStatus: null,
        response: null,
        error: errorMessage(error),
        at: new Date().toISOString(),
    };
    touch();
}

export function recordCodexRetrySuccess(trace, { stage, endpoint, status } = {}) {
    if (!isCurrent(trace)) return;
    latestStatus.phase = latestStatus.reconnects > 0 ? "recovered" : "connected";
    latestStatus.stage = stage || latestStatus.stage;
    latestStatus.endpoint = endpoint || latestStatus.endpoint;
    latestStatus.lastHttpStatus = Number.isInteger(status) ? status : latestStatus.lastHttpStatus;
    touch();
}

export function recordCodexRetryStopped(trace, { reason } = {}) {
    if (!isCurrent(trace)) return;
    latestStatus.active = false;
    latestStatus.phase = "stopped";
    latestStatus.stopReason = typeof reason === "string" && reason.trim()
        ? reason.trim()
        : "挤入重试已停止";
    touch();
}

export function finishCodexRetryTrace(trace, { outcome, status, error, stage } = {}) {
    if (!isCurrent(trace)) return;
    latestStatus.active = false;
    if (latestStatus.phase === "stopped") {
        touch();
        return;
    }
    if (outcome === "success" && latestStatus.phase !== "failed") {
        latestStatus.phase = latestStatus.reconnects > 0 ? "recovered" : "connected";
    }
    else if (outcome === "stopped") latestStatus.phase = "stopped";
    else if (outcome !== "success") latestStatus.phase = "failed";
    if (Number.isInteger(status)) latestStatus.lastHttpStatus = status;
    if (error) {
        latestStatus.lastFailure = {
            stage: stage || latestStatus.stage,
            endpoint: latestStatus.endpoint,
            httpStatus: null,
            response: null,
            error: errorMessage(error),
            at: new Date().toISOString(),
        };
    }
    touch();
}

export function getCodexRetryStatus() {
    return structuredClone(latestStatus);
}

export function resetCodexRetryStatusForTests() {
    latestStatus = idleStatus();
}
