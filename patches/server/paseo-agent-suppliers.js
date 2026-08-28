import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PI_THINKING_OPTION_IDS } from "./paseo-provider-config.js";

const STORE_FILE = "agent-supplier-profiles.json";
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_CONTEXT_WINDOW_TOKENS = 4_000_000;
const MIN_CONTEXT_WINDOW_TOKENS = 1024;
const API_PROTOCOLS = new Set(["native", "openai-compatible"]);
const THINKING_OPTION_IDS = new Set(PI_THINKING_OPTION_IDS);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requireId(value, label) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!ID_PATTERN.test(id)) throw new Error(`${label} must match ${ID_PATTERN}`);
  return id;
}

function optionalText(value, label, maximum = 8192) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function normalizeModels(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Supplier models must be an array");
  const result = [];
  for (const item of value) {
    const model = optionalText(typeof item === "string" ? item : item?.id, "Supplier model", 200);
    if (model && !result.includes(model)) result.push(model);
  }
  return result;
}

function normalizedBaseUrl(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.replace(/\/+$/u, "");
}

function normalizeContextWindow(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < MIN_CONTEXT_WINDOW_TOKENS || numeric > MAX_CONTEXT_WINDOW_TOKENS) {
    throw new Error(`Supplier context window must be an integer from ${MIN_CONTEXT_WINDOW_TOKENS} to ${MAX_CONTEXT_WINDOW_TOKENS}`);
  }
  return numeric;
}

function normalizeThinkingOptionId(value) {
  if (value === undefined || value === null || value === "") return "";
  const id = optionalText(value, "Supplier thinking option", 40);
  if (!THINKING_OPTION_IDS.has(id)) throw new Error("Supplier thinking option is unsupported");
  return id;
}

function normalizeAgentModelId(agentFamilyId, value) {
  const model = optionalText(value, "Supplier model", 200);
  if (!model || agentFamilyId !== "pi" || model.includes("/")) return model;
  return `openai/${model}`;
}

function normalizeEnv(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("Supplier environment must be an object");
  const env = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof raw !== "string" || raw.length > 65536 || /[\0\r\n]/u.test(raw)) {
      throw new Error(`Invalid supplier environment variable: ${key}`);
    }
    env[key] = raw;
  }
  return env;
}

function storePath(paseoHome) {
  if (typeof paseoHome !== "string" || !paseoHome.trim()) throw new Error("Paseo home is required");
  return path.join(paseoHome, STORE_FILE);
}

async function readState(paseoHome) {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath(paseoHome), "utf8"));
    return isRecord(parsed) && isRecord(parsed.agents) ? parsed : { version: 1, agents: {} };
  }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { version: 1, agents: {} };
  }
}

async function writeState(paseoHome, state) {
  const filePath = storePath(paseoHome);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  }
  finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function normalizeStoredProfile(profile, fallbackId, agentId = "") {
  if (!isRecord(profile)) return null;
  const id = requireId(profile.id ?? fallbackId, "Supplier id");
  return {
    id,
    name: optionalText(profile.name, "Supplier name", 200) || id,
    apiProtocol: API_PROTOCOLS.has(profile.apiProtocol) ? profile.apiProtocol : "native",
    baseUrl: optionalText(profile.baseUrl, "Supplier base URL", 8192),
    apiKey: optionalText(profile.apiKey, "Supplier API key", 8192),
    model: optionalText(profile.model, "Supplier model", 200),
    models: normalizeModels(profile.models),
    contextWindowMaxTokens: normalizeContextWindow(profile.contextWindowMaxTokens),
    thinkingOptionId: agentId === "pi"
      ? normalizeThinkingOptionId(profile.thinkingOptionId ?? profile.options?.thinkingOptionId ?? "medium")
      : "",
    env: normalizeEnv(profile.env) ?? {},
    options: isRecord(profile.options) ? clone(profile.options) : {},
    createdAt: typeof profile.createdAt === "string" ? profile.createdAt : new Date().toISOString(),
    updatedAt: typeof profile.updatedAt === "string" ? profile.updatedAt : new Date().toISOString(),
  };
}

function profileView(profile, activeId) {
  return {
    id: profile.id,
    name: profile.name,
    apiProtocol: profile.apiProtocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    models: [...profile.models],
    contextWindowMaxTokens: profile.contextWindowMaxTokens,
    thinkingOptionId: profile.thinkingOptionId,
    envKeys: Object.keys(profile.env).sort(),
    apiKeyConfigured: Boolean(profile.apiKey),
    active: profile.id === activeId,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    options: clone(profile.options),
  };
}

function agentState(state, agentId) {
  const raw = isRecord(state.agents?.[agentId]) ? state.agents[agentId] : {};
  const profiles = Array.isArray(raw.profiles)
    ? raw.profiles.map((profile) => normalizeStoredProfile(profile, undefined, agentId)).filter(Boolean)
    : [];
  const activeId = typeof raw.activeId === "string" && profiles.some((profile) => profile.id === raw.activeId)
    ? raw.activeId
    : profiles[0]?.id ?? null;
  return { activeId, profiles };
}

function publicAgentState(agentId, current) {
  return {
    agentId,
    activeId: current.activeId,
    profiles: current.profiles.map((profile) => profileView(profile, current.activeId)),
  };
}

function buildProfile(agentId, input, existing) {
  requireId(agentId, "Agent id");
  if (!isRecord(input)) throw new Error("Supplier profile must be an object");
  const id = requireId(input.id ?? existing?.id ?? `supplier-${randomUUID().replace(/-/gu, "").slice(0, 12)}`, "Supplier id");
  const now = new Date().toISOString();
  const baseUrl = input.baseUrl === undefined
    ? (existing?.baseUrl ?? "")
    : optionalText(input.baseUrl, "Supplier base URL", 8192);
  const sameBaseUrl = existing && normalizedBaseUrl(existing.baseUrl) === normalizedBaseUrl(baseUrl);
  const profile = {
    id,
    name: optionalText(input.name ?? existing?.name, "Supplier name", 200) || id,
    apiProtocol: input.apiProtocol === undefined ? (existing?.apiProtocol ?? "native") : input.apiProtocol,
    baseUrl,
    apiKey: input.apiKey === undefined
      ? (sameBaseUrl ? (existing?.apiKey ?? "") : "")
      : optionalText(input.apiKey, "Supplier API key", 8192),
    model: input.model === undefined ? (existing?.model ?? "") : optionalText(input.model, "Supplier model", 200),
    models: input.models === undefined ? (existing?.models ?? []) : normalizeModels(input.models),
    contextWindowMaxTokens: input.contextWindowMaxTokens === undefined
      ? (existing?.contextWindowMaxTokens ?? null)
      : normalizeContextWindow(input.contextWindowMaxTokens),
    thinkingOptionId: agentId === "pi"
      ? (input.thinkingOptionId === undefined
        ? (existing?.thinkingOptionId ?? "medium")
        : normalizeThinkingOptionId(input.thinkingOptionId))
      : "",
    env: input.env === undefined ? (existing?.env ?? {}) : (normalizeEnv(input.env) ?? {}),
    options: input.options === undefined ? (existing?.options ?? {}) : (isRecord(input.options) ? clone(input.options) : (() => { throw new Error("Supplier options must be an object"); })()),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (!API_PROTOCOLS.has(profile.apiProtocol)) throw new Error("Supplier API protocol must be native or openai-compatible");
  if (profile.model && !profile.models.includes(profile.model)) profile.models.push(profile.model);
  return profile;
}

export function supplierProfileToProviderInput(profile, agentFamilyId = "") {
  if (!isRecord(profile)) throw new Error("Supplier profile must be an object");
  const model = normalizeAgentModelId(agentFamilyId, profile.model ?? "");
  const thinkingOptionId = agentFamilyId === "pi"
    ? normalizeThinkingOptionId(profile.thinkingOptionId)
    : "";
  const additionalModelIds = [...new Set(normalizeModels(profile.models)
    .map((value) => normalizeAgentModelId(agentFamilyId, value)))];
  if (model && !additionalModelIds.includes(model)) additionalModelIds.push(model);
  return {
    apiProtocol: profile.apiProtocol ?? "native",
    baseUrl: profile.baseUrl ?? "",
    apiKey: profile.apiKey ?? "",
    model,
    additionalModelIds,
    contextWindowMaxTokens: profile.contextWindowMaxTokens ?? null,
    ...(thinkingOptionId
      ? { thinkingOptionId }
      : {}),
    env: normalizeEnv(profile.env) ?? {},
  };
}

export async function listSupplierProfiles(paseoHome, agentId) {
  const id = requireId(agentId, "Agent id");
  const current = agentState(await readState(paseoHome), id);
  return publicAgentState(id, current);
}

export async function getSupplierProfile(paseoHome, agentId, supplierId) {
  const id = requireId(agentId, "Agent id");
  const profileId = requireId(supplierId, "Supplier id");
  const current = agentState(await readState(paseoHome), id);
  const profile = current.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error("Supplier profile not found");
  return clone(profile);
}

export async function saveSupplierProfile(paseoHome, agentId, input) {
  const id = requireId(agentId, "Agent id");
  const state = await readState(paseoHome);
  const current = agentState(state, id);
  const requestedId = input?.id;
  const existing = requestedId ? current.profiles.find((profile) => profile.id === requestedId) : null;
  const profile = buildProfile(id, input, existing);
  const profiles = [...current.profiles.filter((item) => item.id !== profile.id), profile];
  profiles.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const next = { ...state, version: 1, agents: { ...state.agents, [id]: { activeId: current.activeId ?? profile.id, profiles } } };
  await writeState(paseoHome, next);
  return { ...publicAgentState(id, agentState(next, id)), savedSupplierId: profile.id };
}

export async function activateSupplierProfile(paseoHome, agentId, supplierId) {
  const id = requireId(agentId, "Agent id");
  const profileId = requireId(supplierId, "Supplier id");
  const state = await readState(paseoHome);
  const current = agentState(state, id);
  if (!current.profiles.some((profile) => profile.id === profileId)) throw new Error("Supplier profile not found");
  const next = { ...state, version: 1, agents: { ...state.agents, [id]: { activeId: profileId, profiles: current.profiles } } };
  await writeState(paseoHome, next);
  return publicAgentState(id, agentState(next, id));
}

export async function deleteSupplierProfile(paseoHome, agentId, supplierId) {
  const id = requireId(agentId, "Agent id");
  const profileId = requireId(supplierId, "Supplier id");
  const state = await readState(paseoHome);
  const current = agentState(state, id);
  const profiles = current.profiles.filter((profile) => profile.id !== profileId);
  if (profiles.length === current.profiles.length) throw new Error("Supplier profile not found");
  const activeId = current.activeId === profileId ? profiles[0]?.id ?? null : current.activeId;
  const next = { ...state, version: 1, agents: { ...state.agents, [id]: { activeId, profiles } } };
  await writeState(paseoHome, next);
  return publicAgentState(id, agentState(next, id));
}

export function supplierStoreFileName() {
  return STORE_FILE;
}
