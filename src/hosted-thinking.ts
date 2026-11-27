import type { ModelsStoreEntry } from "@earendil-works/pi-ai";
import { record, thinkingSettings, type ChatModel } from "./catalog.ts";

type Row = Record<string, unknown>;
type List = (url: string) => Promise<unknown>;

function leadRoute(row: Row, ids: unknown[]) {
  const providers = Array.isArray(row.providers) ? row.providers.map(record) : [];
  for (const id of ids) {
    if (typeof id !== "string") return;
    const route = providers.find(provider => provider?.id === id);
    if (!route) return;
    if ((route.status === undefined || route.status === "active") &&
      route.routable !== false && route.available_to_org !== false) {
      return route;
    }
  }
}

async function platformCapabilities(url: URL, wanted: Set<string>, list: List) {
  const result = new Map<string, Row>();
  const details: string[] = [];
  const pageUrl = new URL(url);
  pageUrl.searchParams.set("supports", "reasoning");
  pageUrl.searchParams.set("limit", "500");
  let offset = 0;
  while (wanted.size) {
    pageUrl.searchParams.set("offset", String(offset));
    const page = record(await list(pageUrl.href).catch(() => undefined));
    if (!Array.isArray(page?.models) || !page.models.length) break;
    for (const value of page.models) {
      const row = record(value);
      const slug = record(row?.model)?.slug;
      if (!row || typeof slug !== "string" || !wanted.delete(slug)) continue;
      const route = leadRoute(row, Array.isArray(row.default_provider_ids) ? row.default_provider_ids : []);
      const capabilities = record(route?.capabilities);
      if (capabilities) result.set(slug, capabilities);
      else details.push(slug);
    }
    offset += page.models.length;
    if (typeof page.total !== "number" || offset >= page.total) break;
  }
  // Some bulk rows omit the route order. The detail endpoint publishes the default waterfall.
  async function readDetail(slug: string) {
    const row = record(await list(url.href + "/" + encodeURIComponent(slug)).catch(() => undefined));
    if (!Array.isArray(row?.default_waterfall)) return;
    const waterfall = row.default_waterfall.map(record)
      .filter((rung): rung is Row => !!rung && (rung.status === undefined || rung.status === "active"))
      .sort((a, b) => Number(a.position) - Number(b.position));
    const capabilities = record(leadRoute(row, waterfall.map(rung => rung.model_provider_id))?.capabilities);
    if (capabilities) result.set(slug, capabilities);
  }
  for (let start = 0; start < details.length; start += 4) {
    await Promise.all(details.slice(start, start + 4).map(readDetail));
  }
  return result;
}

export async function fillHostedThinking(models: ChatModel[], entries: unknown[], stored: Readonly<ModelsStoreEntry> | undefined,
  url: URL, list: List): Promise<void> {
  const unresolved = new Map(models.filter(model => !model.thinkingLevelMap).map(model => [model.id, model]));
  const slugs = new Map<string, string>();
  for (const value of entries) {
    const entry = record(value);
    if (typeof entry?.id !== "string") continue;
    const model = unresolved.get(entry.id);
    if (model && (model.reasoning || !Array.isArray(entry.supported_parameters))) {
      slugs.set(entry.id, typeof entry.canonical_slug === "string" ? entry.canonical_slug : entry.id);
    }
  }
  const capabilities = await platformCapabilities(url, new Set(slugs.values()), list);
  const cached = new Map(stored?.models.map(model => [model.id, model]));
  for (const model of unresolved.values()) {
    const slug = slugs.get(model.id);
    const route = slug === undefined ? undefined : capabilities.get(slug);
    const previous = cached.get(model.id);
    let efforts = route?.supported_reasoning_efforts;
    if (!Array.isArray(efforts) && previous && "thinkingLevelMap" in previous && previous.thinkingLevelMap &&
      (previous.reasoning || route?.supports_reasoning !== true)) {
      efforts = Object.values(previous.thinkingLevelMap);
    }
    if (Array.isArray(efforts) || typeof route?.supports_reasoning === "boolean") {
      Object.assign(model, thinkingSettings(model.api, efforts, route?.supports_reasoning, model.reasoning));
    }
  }
}
