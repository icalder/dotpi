import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const EXA_URL = "https://mcp.exa.ai/mcp";

const Params = Type.Object({
  query: Type.String({ description: "Web search query" }),
  numResults: Type.Optional(Type.Number({ description: "Number of search results to return (default: 8)" })),
  livecrawl: Type.Optional(
    Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], {
      description:
        "Live crawl mode. fallback uses live crawling as backup; preferred prioritizes live crawling (default: fallback)",
    }),
  ),
  type: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], {
      description: "Search type. auto is balanced, fast is quick, deep is comprehensive (default: auto)",
    }),
  ),
  contextMaxCharacters: Type.Optional(
    Type.Number({ description: "Maximum characters for the LLM-optimized context string" }),
  ),
});

type Params = Static<typeof Params>;

export default function exaSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "websearch",
    label: "Exa Web Search",
    description:
      "Search the web using Exa's public MCP endpoint. Provides current web results and can live crawl relevant pages.",
    promptSnippet: "Search the web for current information with Exa",
    promptGuidelines: [
      "Use websearch when the user asks for current information, recent docs, releases, news, or facts beyond the model's knowledge cutoff.",
      "For recent/current topics, include the current year in the websearch query when helpful.",
    ],
    parameters: Params,
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Searching Exa for: ${params.query}` }], details: { query: params.query, provider: "exa" } });

      try {
        const output = await callExa(params, signal);
        return {
          content: [{ type: "text", text: output ?? "No search results found. Try a different query." }],
          details: { query: params.query, provider: "exa" },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Exa search failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { query: params.query, provider: "exa" },
          isError: true,
        };
      }
    },
  });
}

async function callExa(params: Params, signal?: AbortSignal) {
  const response = await fetch(EXA_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: params.query,
          type: params.type || "auto",
          numResults: params.numResults || 8,
          livecrawl: params.livecrawl || "fallback",
          contextMaxCharacters: params.contextMaxCharacters,
        },
      },
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
  });

  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return parseResponse(await response.text());
}

function parseResponse(body: string) {
  const direct = parsePayload(body.trim());
  if (direct) return direct;

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = parsePayload(line.slice(6).trim());
    if (data) return data;
  }
  return undefined;
}

function parsePayload(payload: string) {
  if (!payload.startsWith("{")) return undefined;
  const data = JSON.parse(payload) as {
    result?: { content?: Array<{ text?: string }> };
    error?: { message?: string };
  };
  if (data.error?.message) throw new Error(data.error.message);
  return data.result?.content?.find((item) => item.text)?.text;
}