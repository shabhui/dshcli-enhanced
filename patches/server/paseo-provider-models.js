const DEFAULT_PROVIDER_BASE_URLS = {
    claude: "https://api.anthropic.com",
    codex: "https://api.openai.com/v1",
};
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_MODEL_PAGES = 100;
const CODEX_COMPATIBLE_USER_AGENT = "codex_cli_rs/paseo";
const CLAUDE_NATIVE_USER_AGENT = "claude-cli/paseo (external, cli)";

// Requests must be indistinguishable from the CLI whose wire protocol they speak:
// Anthropic-native traffic carries the Claude CLI identity, OpenAI-shaped traffic the Codex one.
function cliUserAgent(providerFamilyId, apiProtocol) {
    return providerFamilyId === "claude" && apiProtocol === "native"
        ? CLAUDE_NATIVE_USER_AGENT
        : CODEX_COMPATIBLE_USER_AGENT;
}

function providerDefaultBaseUrl(providerFamilyId) {
    return DEFAULT_PROVIDER_BASE_URLS[providerFamilyId] ?? "";
}

function normalizeBaseUrl(providerFamilyId, value) {
    const raw = typeof value === "string" && value.trim()
        ? value.trim()
        : providerDefaultBaseUrl(providerFamilyId);
    if (!raw) throw new Error("请先填写接口地址");
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new Error("接口地址无效");
    }
    if (parsed.username || parsed.password || parsed.hash) throw new Error("接口地址不能包含账号、密码或片段");
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))) {
        throw new Error("接口地址必须使用 HTTPS；本机回环地址可使用 HTTP");
    }
    return parsed.toString().replace(/\/+$/u, "");
}

function normalizeModelsEndpoint(providerFamilyId, baseUrl, apiProtocol = "native") {
    const normalized = normalizeBaseUrl(providerFamilyId, baseUrl);
    if (/\/models$/iu.test(normalized)) return normalized;
    if (providerFamilyId === "claude" && apiProtocol === "native") {
        if (/\/v1$/iu.test(normalized)) return `${normalized}/models`;
        for (const suffix of ["/v1/messages", "/messages"]) {
            if (normalized.endsWith(suffix)) return `${normalized.slice(0, -suffix.length)}/v1/models`;
        }
        return `${normalized}/v1/models`;
    }
    for (const suffix of ["/responses/compact", "/chat/completions", "/responses"]) {
        if (normalized.endsWith(suffix)) return `${normalized.slice(0, -suffix.length)}/models`;
    }
    return `${normalized}/models`;
}

function extractModelIds(payload) {
    const items = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
            ? payload.models
            : Array.isArray(payload?.data?.models)
                ? payload.data.models
                : Array.isArray(payload)
                    ? payload
                    : [];
    return [...new Set(items
        .map((item) => typeof item === "string" ? item : item?.id ?? item?.model ?? item?.name)
        .filter((id) => typeof id === "string" && id.trim())
        .map((id) => id.trim()))].sort();
}

function comparableBaseUrl(value) {
    return typeof value === "string" ? value.trim().replace(/\/+$/u, "") : "";
}

export function resolveProviderModelRequest(input = {}, saved = {}) {
    const suppliedBaseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
    const savedBaseUrl = typeof saved.baseUrl === "string" ? saved.baseUrl.trim() : "";
    const baseUrl = suppliedBaseUrl || savedBaseUrl;
    const suppliedKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const savedKey = typeof saved.apiKey === "string" ? saved.apiKey : "";
    return {
        apiProtocol: typeof input.apiProtocol === "string" ? input.apiProtocol : saved.apiProtocol,
        baseUrl,
        apiKey: suppliedKey || (comparableBaseUrl(baseUrl) === comparableBaseUrl(savedBaseUrl) ? savedKey : ""),
    };
}

function responseErrorMessage(payload, status) {
    const detail = payload?.error?.message ?? payload?.message ?? payload?.error;
    return typeof detail === "string" && detail.trim()
        ? `获取模型失败：${detail.trim()}`
        : `获取模型失败（HTTP ${status}）`;
}

export async function fetchProviderModels(input, dependencies = {}) {
    const providerId = typeof input?.providerId === "string" ? input.providerId.trim() : "";
    if (!providerId) throw new Error("Provider id is required");
    const providerFamilyId = typeof input?.providerFamilyId === "string" && input.providerFamilyId.trim()
        ? input.providerFamilyId.trim()
        : providerId;
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const apiProtocol = input.apiProtocol === "openai-compatible" ? "openai-compatible" : "native";
    const endpoint = normalizeModelsEndpoint(providerFamilyId, input.baseUrl, apiProtocol);
    const headers = {
        Accept: "application/json",
        "User-Agent": cliUserAgent(providerFamilyId, apiProtocol),
    };
    if (providerFamilyId === "claude" && apiProtocol === "native") {
        if (apiKey) headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
    }
    else if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const fetchImpl = dependencies.fetchImpl ?? fetch;
        const requestUrl = new URL(endpoint);
        const pagedAnthropic = providerFamilyId === "claude" && apiProtocol === "native";
        if (pagedAnthropic) requestUrl.searchParams.set("limit", "100");
        const modelIds = new Set();
        const seenCursors = new Set();
        let nextCursor = "";
        for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
            if (nextCursor) requestUrl.searchParams.set("after_id", nextCursor);
            const response = await fetchImpl(requestUrl.toString(), {
                headers,
                signal: controller.signal,
                redirect: "error",
            });
            const text = await response.text();
            let payload;
            try {
                payload = text ? JSON.parse(text) : null;
            }
            catch {
                const contentType = String(response.headers.get("content-type") || "").toLowerCase();
                if (contentType.includes("text/html") || /^\s*</u.test(text)) {
                    throw new Error("模型接口返回了网页，请检查接口地址是否为 API 地址");
                }
                throw new Error(`模型接口没有返回有效 JSON（HTTP ${response.status}）`);
            }
            if (!response.ok) throw new Error(responseErrorMessage(payload, response.status));
            for (const modelId of extractModelIds(payload)) modelIds.add(modelId);
            if (!pagedAnthropic || payload?.has_more !== true) break;

            const items = Array.isArray(payload?.data) ? payload.data : [];
            const lastItem = items[items.length - 1];
            const cursor = typeof payload?.last_id === "string" && payload.last_id.trim()
                ? payload.last_id.trim()
                : typeof lastItem?.id === "string" ? lastItem.id.trim() : "";
            if (!cursor || seenCursors.has(cursor)) {
                throw new Error("模型接口分页游标无效，无法获取全部模型");
            }
            seenCursors.add(cursor);
            nextCursor = cursor;
            if (page === MAX_MODEL_PAGES - 1) {
                throw new Error("模型接口分页过多，已停止获取");
            }
        }
        const models = [...modelIds].sort();
        if (!models.length) throw new Error("接口没有返回可选择的模型");
        return models;
    }
    finally {
        clearTimeout(timer);
    }
}

export { extractModelIds, normalizeModelsEndpoint };
