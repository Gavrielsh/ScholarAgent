export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface TavilySearchResponse {
  query: string;
  results: TavilySearchResult[];
}

const TAVILY_API_URL = "https://api.tavily.com/search";

export async function tavilySearch(query: string): Promise<TavilySearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    // TODO: Inject Tavily API key via env var TAVILY_API_KEY.
    throw new Error("Missing TAVILY_API_KEY environment variable.");
  }

  const response = await fetch(TAVILY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // TODO: Extend Tavily payload with depth/topic filters per use-case.
      api_key: apiKey,
      query,
      max_results: 5,
      search_depth: "basic",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily search failed: ${response.status} ${body}`);
  }

  const json = (await response.json()) as {
    query?: string;
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      score?: number;
    }>;
  };

  return {
    query: json.query ?? query,
    results: (json.results ?? []).map((result) => ({
      title: result.title ?? "",
      url: result.url ?? "",
      content: result.content ?? "",
      score: result.score,
    })),
  };
}
