import type { LlmMessage } from "@/lib/llm/types";

export interface BaselineTraceHandles {
  endRoot: (output: { answer: string; chunkIds: string[]; latencyMs: number }) => void;
  retrievalSpan: {
    end: (output: { chunkIds: string[]; fusedCount: number }) => void;
  };
  rerankSpan: {
    end: (output: { chunkIds: string[] }) => void;
  };
  /** Call after the final `messages` array for the baseline LLM is assembled. */
  attachLlmGeneration: (messages: LlmMessage[]) => {
    end: (output: { answer: string }) => void;
  };
}

function noopTrace(): BaselineTraceHandles {
  const noop = { end: () => {} };
  const noopGen = { end: () => {} };
  return {
    endRoot: () => {},
    retrievalSpan: noop,
    rerankSpan: noop,
    attachLlmGeneration: () => noopGen,
  };
}

// Langfuse types are optional — keep this module loosely typed so builds succeed
// when the SDK surface shifts between major versions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LangfuseClient = any;

/**
 * Optional Langfuse tracing. Set LANGFUSE_SECRET_KEY (+ LANGFUSE_PUBLIC_KEY for cloud).
 * Traces retrieval, re-ranking, the exact LLM message list, and the model answer.
 */
export async function startBaselineRagTrace(args: {
  userId: string;
  query: string;
  permissionLevel: number;
}): Promise<BaselineTraceHandles> {
  if (!process.env.LANGFUSE_SECRET_KEY) {
    return noopTrace();
  }

  try {
    const { Langfuse } = await import("langfuse");
    const client = new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl: process.env.LANGFUSE_HOST,
    }) as LangfuseClient;

    const root = client.trace({
      name: "baseline-rag",
      userId: args.userId,
      input: { query: args.query },
      metadata: { permissionLevel: args.permissionLevel },
    });

    const retrieval = root.span({ name: "retrieval", input: { query: args.query } });
    const rerank = root.span({ name: "rerank" });

    return {
      endRoot: (output: { answer: string; chunkIds: string[]; latencyMs: number }) => {
        if (typeof root.update === "function") {
          root.update({ output });
        }
        void client.flushAsync?.().catch((err: unknown) => console.error("Langfuse flush failed:", err));
      },
      retrievalSpan: {
        end: (output) => {
          if (typeof retrieval.end === "function") retrieval.end({ output });
        },
      },
      rerankSpan: {
        end: (output) => {
          if (typeof rerank.end === "function") rerank.end({ output });
        },
      },
      attachLlmGeneration: (messages: LlmMessage[]) => {
        const generation = root.generation({
          name: "baseline-llm",
          model: process.env.LLM_PROVIDER ?? "mock",
          input: messages,
        });
        return {
          end: (output: { answer: string }) => {
            if (typeof generation.end === "function") generation.end({ output });
          },
        };
      },
    };
  } catch (err) {
    console.warn("Langfuse tracing disabled:", err);
    return noopTrace();
  }
}
