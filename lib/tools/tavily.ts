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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let response: Response;
  try {
    response = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        // TODO: Extend Tavily payload with depth/topic filters per use-case.
        api_key: apiKey,
        query,
        max_results: 5,
        search_depth: "basic",
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Tavily request timeout after 5000ms.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

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
