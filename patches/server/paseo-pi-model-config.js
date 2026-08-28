import { promises as fs } from "node:fs";
import path from "node:path";

import {
    prepareProviderOverridesForRuntime,
    providerApiValuesFromOverride,
} from "./paseo-provider-config.js";

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedModelSelection(value) {
    if (typeof value !== "string") return null;
    const selection = value.trim();
    if (!selection || selection.length > 200 || /[\0\r\n]/u.test(selection)) return null;
    const separator = selection.indexOf("/");
    const provider = separator > 0 ? selection.slice(0, separator) : "openai";
    const model = separator > 0 ? selection.slice(separator + 1) : selection;
    if (!PROVIDER_ID_PATTERN.test(provider) || !model) return null;
    return { provider, model };
}

export function normalizePiOpenAIBaseUrl(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    const normalized = value.trim().replace(/\/+$/u, "");
    for (const suffix of ["/chat/completions", "/responses", "/models"]) {
        if (normalized.endsWith(suffix)) return normalizePiOpenAIBaseUrl(normalized.slice(0, -suffix.length));
    }
    return /\/v1$/iu.test(normalized) ? normalized : `${normalized}/v1`;
}

export function buildPiModelsConfig(input = {}) {
    const baseUrl = normalizePiOpenAIBaseUrl(input.baseUrl);
    if (!baseUrl) return { providers: {} };
    const grouped = new Map();
    for (const definition of Array.isArray(input.models) ? input.models : []) {
        const rawId = typeof definition === "string" ? definition : definition?.id;
        const selection = normalizedModelSelection(rawId);
        if (!selection) continue;
        const models = grouped.get(selection.provider) ?? new Map();
        const previous = models.get(selection.model) ?? {};
        const contextWindow = Number.isInteger(definition?.contextWindowMaxTokens) && definition.contextWindowMaxTokens > 0
            ? definition.contextWindowMaxTokens
            : previous.contextWindow;
        const reasoning = Array.isArray(definition?.thinkingOptions)
            ? definition.thinkingOptions.some((option) => option?.id !== "off")
            : previous.reasoning;
        models.set(selection.model, {
            id: selection.model,
            name: selection.model,
            ...(reasoning ? { reasoning: true } : {}),
            ...(contextWindow ? { contextWindow } : {}),
        });
        grouped.set(selection.provider, models);
    }
    const providers = {};
    for (const providerId of [...grouped.keys()].sort()) {
        providers[providerId] = {
            baseUrl,
            api: "openai-completions",
            apiKey: "$OPENAI_API_KEY",
            compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
            },
            models: [...grouped.get(providerId).values()].sort((left, right) => left.id.localeCompare(right.id)),
        };
    }
    return { providers };
}

function piAgentDir(paseoHome, providerId) {
    if (typeof paseoHome !== "string" || !paseoHome.trim()) throw new Error("Paseo home is required");
    if (!PROVIDER_ID_PATTERN.test(providerId)) throw new Error("Invalid Pi provider id");
    return path.join(path.resolve(paseoHome), "agents", "pi", providerId);
}

async function writeModelsConfig(agentDir, config) {
    await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
    const target = path.join(agentDir, "models.json");
    const contents = `${JSON.stringify(config, null, 2)}\n`;
    if (await fs.readFile(target, "utf8").catch(() => null) === contents) return;
    const temporary = path.join(agentDir, `.models.json.${process.pid}.${Date.now()}.tmp`);
    try {
        await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.rename(temporary, target);
    }
    finally {
        await fs.unlink(temporary).catch(() => undefined);
    }
}

export async function preparePiProviderOverrides(paseoHome, overrides = {}) {
    if (!isRecord(overrides)) throw new Error("Provider configuration must be an object");
    const prepared = prepareProviderOverridesForRuntime(overrides);
    for (const [providerId, override] of Object.entries(prepared)) {
        if (!isRecord(override)) continue;
        const providerFamily = providerId === "pi" ? "pi" : override.extends;
        if (providerFamily !== "pi") continue;
        const api = providerApiValuesFromOverride(providerId, override, "pi");
        const environment = isRecord(override.env) ? { ...override.env } : {};
        const baseUrl = api.baseUrl || environment.OPENAI_BASE_URL || "";
        const selectedModel = api.model || environment.PI_MODEL || environment.OPENAI_MODEL || "";
        const models = Array.isArray(override.additionalModels) ? [...override.additionalModels] : [];
        if (selectedModel) models.push({ id: selectedModel });
        const config = buildPiModelsConfig({ baseUrl, models });
        if (Object.keys(config.providers).length === 0) {
            delete environment[PI_AGENT_DIR_ENV];
        }
        else {
            const agentDir = piAgentDir(paseoHome, providerId);
            await writeModelsConfig(agentDir, config);
            environment[PI_AGENT_DIR_ENV] = agentDir;
        }
        if (Object.keys(environment).length > 0) override.env = environment;
        else delete override.env;
    }
    return prepared;
}
