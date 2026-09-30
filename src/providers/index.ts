import type { GatewayConfig } from "../config/schema.js";
import { CLAUDE_OPTIONS, ClaudeAdapter } from "./claude.js";
import { GEMINI_OPTIONS, GeminiAdapter } from "./gemini.js";
import { GROK_OPTIONS, GrokAdapter } from "./grok.js";
import { OPENAI_OPTIONS, OpenAIAdapter } from "./openai.js";
import { OPENROUTER_OPTIONS, OpenRouterAdapter } from "./openrouter.js";
import type { OptionDeclarations } from "./options.js";
import type { FetchLike, ProviderAdapter, ProviderName, ProviderSettings } from "./types.js";

const FACTORIES: Record<ProviderName, (settings: ProviderSettings) => ProviderAdapter> = {
  openai: (settings) => new OpenAIAdapter(settings),
  grok: (settings) => new GrokAdapter(settings),
  claude: (settings) => new ClaudeAdapter(settings),
  gemini: (settings) => new GeminiAdapter(settings),
  openrouter: (settings) => new OpenRouterAdapter(settings),
};

/** The `options` keys each adapter reads (see `options.ts`), checked when the config is loaded. */
export const OPTION_DECLARATIONS: Readonly<Record<ProviderName, OptionDeclarations>> = {
  openai: OPENAI_OPTIONS,
  grok: GROK_OPTIONS,
  claude: CLAUDE_OPTIONS,
  gemini: GEMINI_OPTIONS,
  openrouter: OPENROUTER_OPTIONS,
};

/** Instantiate an adapter for every provider that has credentials in the config. */
export function createAdapters(config: GatewayConfig, fetch: FetchLike): Partial<Record<ProviderName, ProviderAdapter>> {
  const adapters: Partial<Record<ProviderName, ProviderAdapter>> = {};
  for (const [name, provider] of Object.entries(config.providers) as Array<[ProviderName, NonNullable<GatewayConfig["providers"][ProviderName]>]>) {
    adapters[name] = FACTORIES[name]({
      apiKey: provider.apiKey,
      fetch,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.headers ? { headers: provider.headers } : {}),
    });
  }
  return adapters;
}

export { ClaudeAdapter, GeminiAdapter, GrokAdapter, OpenAIAdapter, OpenRouterAdapter };
