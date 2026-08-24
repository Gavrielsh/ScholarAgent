import type { LlmMessage } from "@/lib/llm/types";

export interface BaselineTraceHandles {
  endRoot: (output: { answer: string; chunkIds: string[]; latencyMs: number }) => void;
  retrievalSpan: {
    end: (output: { chunkIds: string[]; fusedCount: number }) => void;
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
    attachLlmGeneration: () => noopGen,
  };
}

interface LangfuseObservation {
  end?: (data?: { output?: unknown }) => void;
}

interface LangfuseTrace {
  span: (args: { name: string; input?: unknown }) => LangfuseObservation;
  generation: (args: { name: string; model?: string; input?: unknown }) => LangfuseObservation;
  update?: (data: { output?: unknown }) => void;
}

interface LangfuseClient {
  trace: (args: {
    name: string;
    userId?: string;
    input?: unknown;
    metadata?: unknown;
  }) => LangfuseTrace;
  flushAsync?: () => Promise<unknown>;
}

/**
 * Optional Langfuse tracing. Set LANGFUSE_SECRET_KEY (+ LANGFUSE_PUBLIC_KEY for cloud).
 * Traces retrieval, the exact LLM message list, and the model answer.
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
    }) as unknown as LangfuseClient;

    const root = client.trace({
      name: "baseline-rag",
      userId: args.userId,
      input: { query: args.query },
      metadata: { permissionLevel: args.permissionLevel },
    });

    const retrieval = root.span({ name: "retrieval", input: { query: args.query } });

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
