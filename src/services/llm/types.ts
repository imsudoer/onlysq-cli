export type ContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | ContentPart[];
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

export interface ToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

export interface ToolDef {
    type: "function";
    function: { name: string; description: string; parameters: any };
}

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    tools?: ToolDef[];
    tool_choice?: "auto" | "none";
    stop?: string[];
}

export interface ChatDelta {
    content?: string;
    toolCalls?: ToolCall[];
    finishReason?: string;
}
