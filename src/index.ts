import { createHash } from "node:crypto";
import { createProvider, envApiKeyAuth, type ApiKeyAuth, type ApiKeyCredential, type ModelsStoreEntry } from "@earendil-works/pi-ai";
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseCatalog, type GatewayApi, type GatewayId } from "./catalog.ts";

const hostedUrl = "https://api.experientiallabs.ai/api/v1";
const localUrl = "http://127.0.0.1:8000/v1";

function apiRoot(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Set the Experiential gateway URL to an HTTP(S) endpoint without credentials, query, or fragment.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path : path + "/v1";
  return url.href;
}

interface ScopedCatalog extends ModelsStoreEntry {
  gatewayScope: string;
}

function credentialForEndpoint(credential: ApiKeyCredential | undefined, endpoint: string | undefined) {
  if (!endpoint || credential?.env?.EXPLABS_BASE_URL === endpoint) return credential;
  return undefined;
}

function gatewayAuth(name: string, variables: string[], endpoint?: string): ApiKeyAuth {
  const auth = envApiKeyAuth(name + " API key", variables);
  if (!endpoint) return auth;

  const resolve: ApiKeyAuth["resolve"] = async input => {
    const credential = credentialForEndpoint(input.credential, endpoint);
    const result = await auth.resolve({ ...input, credential });
    if (result) {
      return {
        ...result,
        auth: { ...result.auth, baseUrl: endpoint },
        env: { ...result.env, EXPLABS_BASE_URL: endpoint },
      };
    }
  };
  return {
    name: auth.name,
    async login(interaction) {
      const credential = await auth.login!(interaction);
      return { ...credential, env: { EXPLABS_BASE_URL: endpoint } };
    },
    resolve,
    async check(input) {
      const result = await resolve(input);
      if (result) return { type: "api_key", source: result.source };
    },
  };
}

export function gatewayProvider(id: GatewayId, endpoint: string) {
  const baseUrl = apiRoot(endpoint);
  const hosted = id === "experiential";
  const localEndpoint = hosted ? undefined : baseUrl;
  const catalogRoot = (override?: string) => localEndpoint ?? apiRoot(override ?? baseUrl);
  const keyVariables = hosted ? ["EXPLABS_API_KEY", "EXP_API_KEY"] : ["EXP_GATEWAY_KEY"];
  const name = hosted ? "Experiential Labs" : "Experiential Labs (self-hosted)";
  const aliases = hosted ? ["experiential-small-model", "experiential-large-model"] : [];
  const provider = createProvider<GatewayApi>({
    id,
    name,
    baseUrl,
    auth: { apiKey: gatewayAuth(name, keyVariables, localEndpoint) },
    api: {
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
      "anthropic-messages": anthropicMessagesApi(),
    },
    models: parseCatalog({ data: aliases.map(id => ({ id })) }, id, baseUrl),
    async fetchModels(context) {
      const key = context.credential?.type === "api_key" && context.credential.key;
      if (!key) throw new Error("Sign in to " + name + " in Pi before refreshing its models.");
      const root = catalogRoot(context.baseUrl);
      const response = await fetch(root + "/models", {
        headers: { Accept: "application/json", Authorization: "Bearer " + key },
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]),
        redirect: "error",
      });
      if (!response.ok) {
        const hint = response.status === 401 || response.status === 403 ? " Check the gateway API key." : "";
        throw new Error(name + " model discovery returned HTTP " + response.status + "." + hint);
      }
      return parseCatalog(await response.json(), id, root);
    },
  });

  // Pi stores one catalog per provider ID. Private aliases and model endpoints belong to one key and gateway.
  const refresh = provider.refreshModels!;
  provider.refreshModels = async context => {
    const credential = context.credential?.type === "api_key" ? context.credential : undefined;
    const key = credentialForEndpoint(credential, localEndpoint)?.key;
    const effectiveKey = key || keyVariables.map(variable => process.env[variable]).find(Boolean);
    const scope = effectiveKey && createHash("sha256").update(catalogRoot(context.baseUrl))
      .update("\0").update(effectiveKey).digest("hex");
    const stored = context.stored as Readonly<ScopedCatalog> | undefined;
    await refresh({
      ...context,
      stored: scope && stored?.gatewayScope === scope ? stored : { models: [] },
      publish: publication => {
        if (!publication.persist || !scope) return context.publish(publication);
        const persist: ScopedCatalog = { ...publication.persist, gatewayScope: scope };
        return context.publish({ ...publication, persist });
      },
    });
  };
  return provider;
}

export default function experiential(pi: ExtensionAPI): void {
  pi.registerProvider(gatewayProvider("experiential", hostedUrl));
  if (process.env.EXPLABS_BASE_URL || process.env.EXP_GATEWAY_KEY) {
    pi.registerProvider(gatewayProvider("experiential-local", process.env.EXPLABS_BASE_URL || localUrl));
  }
}
