export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt?: string;
}

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  result?: string;
}

export interface RetrievedContext {
  source: "tavily" | "pgvector";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AgentGraphState {
  messages: ChatMessage[];
  mission: string;
  plan: PlanStep[];
  gathered_context: RetrievedContext[];
  current_step_index: number;
  final_response?: string;
}
