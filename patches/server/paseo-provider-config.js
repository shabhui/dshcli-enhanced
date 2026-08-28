const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;

export const CODEX_REASONING_EFFORT_IDS = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const PI_THINKING_OPTION_IDS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PASEO_CONTEXT_WINDOW_PARAM = "paseoContextWindowMaxTokens";
const MIN_CONTEXT_WINDOW_TOKENS = 1024;
const MAX_CONTEXT_WINDOW_TOKENS = 4_000_000;

const PROVIDER_API_ENV = {
    claude: {
        native: { baseUrl: "ANTHROPIC_BASE_URL", apiKey: "ANTHROPIC_API_KEY", model: "ANTHROPIC_MODEL" },
        "openai-compatible": { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY", model: "OPENAI_MODEL" },
    },
    codex: {
        native: { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY", model: "OPENAI_MODEL" },
        "openai-compatible": { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY", model: "OPENAI_MODEL" },
    },
    copilot: {
        native: { baseUrl: "GITHUB_API_URL", apiKey: "GITHUB_TOKEN", model: "COPILOT_MODEL" },
        "openai-compatible": { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY", model: "OPENAI_MODEL" },
    },
    opencode: {
        native: { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY", model: "OPENCODE_MODEL" },
        "openai-compatible": { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY", model: "OPENAI_MODEL" },
    },
    pi: {
        native: { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY", model: "PI_MODEL" },
        "openai-compatible": { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY", model: "OPENAI_MODEL" },
    },
    omp: {
        native: { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY", model: "OMP_MODEL" },
        "openai-compatible": { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY", model: "OPENAI_MODEL" },
    },
};
const API_PROTOCOL_PARAM = "paseoApiProtocol";
const API_PROTOCOLS = ["native", "openai-compatible"];

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function validateCommand(command) {
    if (!Array.isArray(command) || command.length === 0 || command.length > 32 ||
        command.some((item) => typeof item !== "string" || !item.trim() || item.length > 8192 || /\0/u.test(item))) {
        throw new Error("Provider command must be a non-empty string array");
    }
    return command.map((item) => item.trim());
}

function validateEnvironment(environment) {
    if (!isRecord(environment)) throw new Error("Provider environment must be a JSON object");
    const result = {};
    for (const [key, value] of Object.entries(environment)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string" || value.length > 65536 || /[\0\r\n]/u.test(value)) {
            throw new Error(`Invalid provider environment variable: ${key}`);
        }
        result[key] = value;
    }
    return result;
}

function validateApiValue(value, label) {
    if (typeof value !== "string" || value.length > 8192 || /[\0\r\n]/u.test(value)) {
        throw new Error(`Provider ${label} is invalid`);
    }
    return value.trim();
}

function normalizeModelId(value) {
    if (typeof value !== "string") throw new Error("Provider model id must be a string");
    const id = value.trim();
    if (!id) return "";
    if (id.length > 200 || /[\0\r\n]/u.test(id)) throw new Error("Provider model id is invalid");
    return id;
}

export function normalizeProviderContextWindow(value) {
    if (value === null || value === "") return null;
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < MIN_CONTEXT_WINDOW_TOKENS || numeric > MAX_CONTEXT_WINDOW_TOKENS) {
        throw new Error(`Provider context window must be an integer from ${MIN_CONTEXT_WINDOW_TOKENS} to ${MAX_CONTEXT_WINDOW_TOKENS} tokens`);
    }
    return numeric;
}

export function modelIdsToAdditionalModels(modelIds, options = {}) {
    if (!Array.isArray(modelIds)) throw new Error("Provider model ids must be an array");
    const defaultModel = typeof options.defaultModel === "string"
        ? normalizeModelId(options.defaultModel)
        : "";
    const ids = new Set();
    for (const value of modelIds) {
        const id = normalizeModelId(value);
        if (id) ids.add(id);
    }
    if (defaultModel) ids.add(defaultModel);

    const thinkingOptionIds = [];
    if (options.thinkingOptionIds !== undefined) {
        if (!Array.isArray(options.thinkingOptionIds)) {
            throw new Error("Provider thinking option ids must be an array");
        }
        const seenThinking = new Set();
        for (const value of options.thinkingOptionIds) {
            const id = normalizeModelId(value);
            if (id && !seenThinking.has(id)) {
                seenThinking.add(id);
                thinkingOptionIds.push(id);
            }
        }
    }
    const defaultThinkingOptionId = typeof options.defaultThinkingOptionId === "string"
        ? normalizeModelId(options.defaultThinkingOptionId)
        : "";
    if (defaultThinkingOptionId && !thinkingOptionIds.includes(defaultThinkingOptionId)) {
        throw new Error("Provider default thinking option must be included in thinking option ids");
    }

    return [...ids].sort().map((id) => ({
        id,
        label: id,
        ...(id === defaultModel ? { isDefault: true } : {}),
        ...(options.contextWindowMaxTokens ? { contextWindowMaxTokens: normalizeProviderContextWindow(options.contextWindowMaxTokens) } : {}),
        ...(thinkingOptionIds.length > 0
            ? {
                thinkingOptions: thinkingOptionIds.map((thinkingId) => ({
                    id: thinkingId,
                    label: thinkingId,
                    ...(thinkingId === defaultThinkingOptionId ? { isDefault: true } : {}),
                })),
            }
            : {}),
    }));
}

function providerApiEnv(providerId, protocol = "native") {
    const definitions = PROVIDER_API_ENV[providerId];
    if (definitions) return definitions[protocol] ?? definitions.native;
    return {
        baseUrl: "OPENAI_BASE_URL",
        apiKey: "OPENAI_API_KEY",
        model: "OPENAI_MODEL",
    };
}

function normalizeApiProtocol(value) {
    const protocol = typeof value === "string" && value.trim() ? value.trim() : "native";
    if (!API_PROTOCOLS.includes(protocol)) throw new Error("Provider API protocol must be native or openai-compatible");
    return protocol;
}

function normalizeApiEndpoint(value) {
    return typeof value === "string" ? value.trim().replace(/\/+$/u, "") : "";
}

function inferApiProtocol(providerId, override = {}) {
    const params = isRecord(override.params) ? override.params : {};
    if (typeof params[API_PROTOCOL_PARAM] === "string" && params[API_PROTOCOL_PARAM].trim()) return normalizeApiProtocol(params[API_PROTOCOL_PARAM]);
    const environment = isRecord(override.env) ? override.env : {};
    const native = providerApiEnv(providerId, "native");
    const openai = providerApiEnv(providerId, "openai-compatible");
    if (providerId !== "codex" && Object.keys(openai).some((key) => environment[openai[key]])) return "openai-compatible";
    if (Object.keys(native).some((key) => environment[native[key]])) return "native";
    return "native";
}

export function providerApiValuesFromOverride(providerId, override = {}, providerFamily = providerId) {
    const environment = isRecord(override.env) ? override.env : {};
    const params = isRecord(override.params) ? override.params : {};
    const apiProtocol = inferApiProtocol(providerFamily, override);
    const envNames = providerApiEnv(providerFamily, apiProtocol);
    const value = (field) => {
        const environmentValue = environment[envNames[field]];
        if (typeof environmentValue === "string") return environmentValue;
        const legacyValue = params[field];
        return typeof legacyValue === "string" ? legacyValue : "";
    };
    return {
        baseUrl: value("baseUrl"),
        apiKey: value("apiKey"),
        model: value("model"),
        apiProtocol,
    };
}

function mergeProviderApi(updated, current, providerId, input, providerFamily = providerId) {
    const hasApiInput = ["apiProtocol", "baseUrl", "apiKey", "model"].some((field) =>
        Object.prototype.hasOwnProperty.call(input, field));
    const hasEnvironmentInput = Object.prototype.hasOwnProperty.call(input, "env");
    if (!hasApiInput && !hasEnvironmentInput) return;

    const previousEnvironment = isRecord(current.env) ? current.env : {};
    const previousParams = isRecord(current.params) ? current.params : {};
    let environment = isRecord(updated.env) ? { ...updated.env } : {};
    if (input.replaceEnv === true) environment = isRecord(input.env) ? { ...input.env } : {};
    const params = isRecord(updated.params) ? { ...updated.params } : {};
    const currentProtocol = inferApiProtocol(providerFamily, current);
    const apiProtocol = Object.prototype.hasOwnProperty.call(input, "apiProtocol")
        ? normalizeApiProtocol(input.apiProtocol)
        : currentProtocol;
    const envNames = providerApiEnv(providerFamily, apiProtocol);
    const previousApi = providerApiValuesFromOverride(providerId, current, providerFamily);
    const endpointChanged = Object.prototype.hasOwnProperty.call(input, "baseUrl") &&
        normalizeApiEndpoint(input.baseUrl) !== normalizeApiEndpoint(previousApi.baseUrl);
    const protocolChanged = apiProtocol !== currentProtocol;
    const environmentProvidesKey = isRecord(input.env) &&
        typeof input.env[envNames.apiKey] === "string" && input.env[envNames.apiKey].trim().length > 0;
    const credentialProvided = Object.prototype.hasOwnProperty.call(input, "apiKey") || environmentProvidesKey;
    const credentialScopeChanged = endpointChanged || protocolChanged;
    const isBuiltinProvider = Object.prototype.hasOwnProperty.call(PROVIDER_API_ENV, providerFamily);
    if (Object.prototype.hasOwnProperty.call(input, "apiProtocol") || Object.prototype.hasOwnProperty.call(params, API_PROTOCOL_PARAM)) {
        params[API_PROTOCOL_PARAM] = apiProtocol;
    }
    for (const protocol of API_PROTOCOLS) {
        const names = providerApiEnv(providerFamily, protocol);
        if (protocol === apiProtocol) continue;
        for (const field of ["baseUrl", "apiKey", "model"]) delete environment[names[field]];
    }
    if (credentialScopeChanged && !credentialProvided) {
        for (const protocol of API_PROTOCOLS) {
            delete environment[providerApiEnv(providerFamily, protocol).apiKey];
        }
    }

    for (const field of ["baseUrl", "apiKey", "model"]) {
        const envName = envNames[field];
        if (Object.prototype.hasOwnProperty.call(input, field)) {
            if (input[field] === null || input[field] === "") {
                delete environment[envName];
            }
            else {
                const value = validateApiValue(input[field], field);
                if (value) environment[envName] = value;
                else delete environment[envName];
            }
        }
        else if (!Object.prototype.hasOwnProperty.call(environment, envName) &&
            !(field === "apiKey" && credentialScopeChanged)) {
            const previousValue = previousEnvironment[envName];
            const legacyValue = previousParams[field];
            if (typeof previousValue === "string") environment[envName] = previousValue;
            else if (isBuiltinProvider && typeof legacyValue === "string" && legacyValue.length > 0) {
                environment[envName] = validateApiValue(legacyValue, field);
            }
        }
        if (isBuiltinProvider) delete params[field];
    }

    if (Object.keys(params).length > 0) updated.params = params;
    else delete updated.params;
    if (Object.keys(environment).length > 0) updated.env = environment;
    else delete updated.env;
}

export function mergeProviderOverride(existing = {}, input = {}) {
    return mergeProviderOverrides({ selected: existing }, "selected", input).selected ?? {};
}

export function mergeProviderOverrides(overrides = {}, providerId, input = {}, options = {}) {
    assertProviderId(providerId);
    if (!isRecord(overrides) || !isRecord(input)) throw new Error("Provider configuration must be an object");
    const next = Object.fromEntries(Object.entries(overrides).map(([id, value]) => [id, clone(value) ?? {}]));
    const current = isRecord(next[providerId]) ? next[providerId] : {};
    const updated = { ...current };
    for (const field of ["extends", "label", "description"]) {
        if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
        if (input[field] === null || input[field] === "") delete updated[field];
        else if (typeof input[field] !== "string" || input[field].length > 8192 || /[\0\r\n]/u.test(input[field])) {
            throw new Error(`Provider ${field} is invalid`);
        }
        else updated[field] = input[field].trim();
    }
    if (Object.prototype.hasOwnProperty.call(input, "enabled")) {
        if (typeof input.enabled !== "boolean") throw new Error("Provider enabled must be boolean");
        updated.enabled = input.enabled;
    }
    if (Object.prototype.hasOwnProperty.call(input, "command")) {
        if (input.command === null) delete updated.command;
        else updated.command = validateCommand(input.command);
    }
    if (Object.prototype.hasOwnProperty.call(input, "env")) {
        if (input.env === null) delete updated.env;
        else updated.env = validateEnvironment(input.env);
    }
    if (Object.prototype.hasOwnProperty.call(input, "additionalModels")) {
        if (input.additionalModels === null) delete updated.additionalModels;
        else if (!Array.isArray(input.additionalModels)) throw new Error("Provider additionalModels must be an array");
        else updated.additionalModels = clone(input.additionalModels);
    }
    if (Object.prototype.hasOwnProperty.call(input, "contextWindowMaxTokens")) {
        const params = isRecord(updated.params) ? { ...updated.params } : {};
        const contextWindow = normalizeProviderContextWindow(input.contextWindowMaxTokens);
        if (contextWindow === null) delete params[PASEO_CONTEXT_WINDOW_PARAM];
        else params[PASEO_CONTEXT_WINDOW_PARAM] = contextWindow;
        if (Object.keys(params).length > 0) updated.params = params;
        else delete updated.params;
    }
    const providerFamily = typeof options.providerFamily === "string" && options.providerFamily.trim()
        ? options.providerFamily.trim()
        : providerId;
    mergeProviderApi(updated, current, providerId, input, providerFamily);
    if (Object.keys(updated).length === 0) delete next[providerId];
    else next[providerId] = updated;
    return next;
}

export function providerViewFromSnapshot(entry, override = {}) {
    const environment = isRecord(override.env) ? override.env : {};
    const params = isRecord(override.params) ? override.params : {};
    const agentFamilyId = typeof entry.agentFamilyId === "string" && entry.agentFamilyId.trim()
        ? entry.agentFamilyId.trim()
        : typeof entry.extends === "string" && entry.extends.trim()
            ? entry.extends.trim()
            : typeof override.extends === "string" && override.extends.trim()
                ? override.extends.trim()
                : entry.provider;
    const apiValues = providerApiValuesFromOverride(entry.provider, override, agentFamilyId);
    const apiKeyConfigured = Boolean(apiValues.apiKey);
    return {
        id: entry.provider,
        agentFamilyId,
        extends: agentFamilyId === entry.provider ? null : agentFamilyId,
        label: entry.label ?? entry.provider,
        description: entry.description ?? "",
        status: entry.status,
        enabled: entry.enabled !== false,
        available: entry.enabled !== false && entry.status === "ready",
        error: entry.error ?? null,
        config: {
            configured: Object.keys(override).length > 0,
            command: Array.isArray(override.command) ? [...override.command] : null,
            envKeys: Object.keys(environment).sort(),
            additionalModels: Array.isArray(override.additionalModels) ? clone(override.additionalModels) : [],
            contextWindowMaxTokens: Number.isInteger(params[PASEO_CONTEXT_WINDOW_PARAM]) ? params[PASEO_CONTEXT_WINDOW_PARAM] : null,
            api: {
                baseUrl: apiValues.baseUrl,
                model: apiValues.model,
                apiProtocol: apiValues.apiProtocol,
                protocolOptions: [...API_PROTOCOLS],
                apiKeyConfigured,
            },
        },
    };
}

// CLIs that speak exactly one wire protocol, so their process environment must always be the
// native one. The saved apiProtocol still selects the model-discovery endpoint, but handing an
// OpenAI-shaped environment to one of these CLIs leaves it unauthenticated on its default host.
const NATIVE_ONLY_CLI_FAMILIES = new Set(["claude"]);

// The Anthropic wire protocol takes the API root: its client appends `/v1/messages` itself, so a
// base URL that already carries `/v1` (or a whole messages path) becomes `/v1/v1/messages`. Model
// discovery accepts both spellings, which makes this easy to miss -- the model list loads and then
// every real turn 404s.
const ANTHROPIC_BASE_URL_SUFFIXES = ["/v1/messages", "/messages", "/v1"];

function anthropicRootBaseUrl(value) {
    if (typeof value !== "string") return value;
    const normalized = value.trim().replace(/\/+$/u, "");
    for (const suffix of ANTHROPIC_BASE_URL_SUFFIXES) {
        if (normalized.toLowerCase().endsWith(suffix)) {
            return normalized.slice(0, -suffix.length).replace(/\/+$/u, "");
        }
    }
    return normalized;
}

const NATIVE_BASE_URL_NORMALIZERS = { claude: anthropicRootBaseUrl };

function providerFamilyOf(providerId, override) {
    return typeof override.extends === "string" && override.extends.trim()
        ? override.extends.trim()
        : providerId;
}

function forceNativeCliEnvironment(providerId, override) {
    const family = providerFamilyOf(providerId, override);
    if (!NATIVE_ONLY_CLI_FAMILIES.has(family)) return;
    const normalizeBase = NATIVE_BASE_URL_NORMALIZERS[family] ?? ((value) => value);
    const nativeNames = providerApiEnv(family, "native");
    const api = providerApiValuesFromOverride(providerId, override, family);
    if (api.apiProtocol === "native") {
        const saved = isRecord(override.env) ? override.env[nativeNames.baseUrl] : undefined;
        const root = normalizeBase(saved);
        if (typeof root === "string" && root && root !== saved) {
            override.env = { ...override.env, [nativeNames.baseUrl]: root };
        }
        return;
    }
    const environment = isRecord(override.env) ? { ...override.env } : {};
    for (const protocol of API_PROTOCOLS) {
        const names = providerApiEnv(family, protocol);
        for (const field of ["baseUrl", "apiKey", "model"]) delete environment[names[field]];
    }
    for (const field of ["baseUrl", "apiKey", "model"]) {
        if (!api[field]) continue;
        environment[nativeNames[field]] = field === "baseUrl" ? normalizeBase(api[field]) : api[field];
    }
    if (Object.keys(environment).length > 0) override.env = environment;
    else delete override.env;
}

export function prepareProviderOverridesForRuntime(overrides = {}) {
    const prepared = clone(overrides) ?? {};
    for (const [providerId, override] of Object.entries(prepared)) {
        if (!isRecord(override)) continue;
        forceNativeCliEnvironment(providerId, override);
        const params = isRecord(override.params) ? { ...override.params } : {};
        const contextWindow = normalizeProviderContextWindow(params[PASEO_CONTEXT_WINDOW_PARAM] ?? null);
        delete params[API_PROTOCOL_PARAM];
        delete params[PASEO_CONTEXT_WINDOW_PARAM];
        if (Object.keys(params).length > 0) override.params = params;
        else delete override.params;
        if (contextWindow !== null && Array.isArray(override.additionalModels)) {
            override.additionalModels = override.additionalModels.map((model) => ({
                ...model,
                contextWindowMaxTokens: contextWindow,
            }));
        }
    }
    return prepared;
}

export function mergeProviderSnapshotEntries(entries = [], registeredProviderIds = [], definitions = {}, overrides = {}) {
    const byId = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (entry && typeof entry.provider === "string" && entry.provider.trim()) byId.set(entry.provider, entry);
    }
    const ids = new Set(byId.keys());
    for (const id of Array.isArray(registeredProviderIds) ? registeredProviderIds : []) {
        if (typeof id === "string" && id.trim()) ids.add(id.trim());
    }
    if (isRecord(definitions)) {
        for (const id of Object.keys(definitions)) ids.add(id);
    }
    return [...ids].map((providerId) => {
        const entry = byId.get(providerId) ?? {};
        const definition = isRecord(definitions?.[providerId]) ? definitions[providerId] : {};
        const override = isRecord(overrides?.[providerId]) ? overrides[providerId] : {};
        return providerViewFromSnapshot({
            provider: providerId,
            agentFamilyId: entry.agentFamilyId
                ?? definition.derivedFromProviderId
                ?? definition.extends
                ?? entry.extends
                ?? override.extends
                ?? providerId,
            extends: entry.extends ?? definition.derivedFromProviderId ?? definition.extends ?? override.extends ?? providerId,
            label: entry.label ?? definition.label ?? override.label ?? providerId,
            description: entry.description ?? definition.description ?? override.description ?? "",
            status: entry.status ?? definition.status ?? "unavailable",
            enabled: entry.enabled ?? definition.enabled ?? override.enabled ?? true,
            error: entry.error ?? definition.error ?? null,
        }, override);
    });
}

function mutableProviderSettingsFromOverrides(overrides) {
    const providers = {};
    for (const [providerId, override] of Object.entries(overrides)) {
        if (!isRecord(override)) continue;
        const mutable = {};
        if (typeof override.enabled === "boolean") mutable.enabled = override.enabled;
        if (Array.isArray(override.additionalModels)) mutable.additionalModels = clone(override.additionalModels);
        if (Object.keys(mutable).length > 0) providers[providerId] = mutable;
    }
    return providers;
}

export function applyProviderOverridesToRuntime(runtime, overrides) {
    if (!isRecord(overrides)) throw new Error("Provider configuration must be an object");
    const preparedOverrides = prepareProviderOverridesForRuntime(overrides);
    const baseOverrides = Object.keys(preparedOverrides).length > 0 ? preparedOverrides : undefined;
    const mutableProviders = mutableProviderSettingsFromOverrides(preparedOverrides);

    if (runtime.daemonConfigStore) {
        const current = runtime.daemonConfigStore.get();
        runtime.daemonConfigStore.current = { ...current, providers: mutableProviders };
    }

    runtime.providerSnapshotManager.baseProviderOverrides = baseOverrides;
    const state = runtime.providerSnapshotManager.applyMutableProviderConfig(mutableProviders);
    runtime.agentManager.updateProviderRegistry(state);
    return state;
}

export function assertProviderId(value) {
    if (typeof value !== "string" || !PROVIDER_ID_PATTERN.test(value)) {
        throw new Error("Invalid provider id");
    }
    return value;
}
