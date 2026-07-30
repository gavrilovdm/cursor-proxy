import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/** Aliases accepted in place of upstream model ids. */
export const MODEL_ALIASES: Record<string, string> = {
  cpxopus: "claude-opus-5",
  cpxsonnet: "claude-sonnet-5",
  cpxhaiku: "claude-haiku-4-5-20251001",
};

export const CLAUDE_CODE_BILLING_SYSTEM =
  "x-anthropic-billing-header: cc_version=2.1.220.5bd; cc_entrypoint=sdk-cli;";

export interface OpenAiChatCompletionRequest {
  model: string;
  messages?: OpenAiMessage[];
  input?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: OpenAiTool[];
  tool_choice?: OpenAiToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: unknown;
}

interface OpenAiMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

type OpenAiToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "function";
      function: { name: string };
    };

interface OpenAiToolCall {
  id: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface AnthropicMessageResponse {
  id: string;
  model?: string;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  content?: AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text?: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input?: unknown;
    };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicRequestContent[];
};

type AnthropicRequestContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export function toAnthropicMessagesRequest(
  request: OpenAiChatCompletionRequest,
): unknown {
  const system: string[] = [CLAUDE_CODE_BILLING_SYSTEM];
  const messages: AnthropicMessage[] = [];
  const toolUseIds = createToolUseIdMapper();

  for (const message of normalizeOpenAiMessages(request)) {
    if (message.role === "system" || message.role === "developer") {
      const content = stringifyOpenAiContent(message.content);
      if (content) system.push(content);
      continue;
    }

    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseIds(message.tool_call_id ?? "tool_call"),
            content: stringifyOpenAiContent(message.content),
          },
        ],
      });
      continue;
    }

    const role = message.role === "assistant" ? "assistant" : "user";
    const content = toAnthropicContentBlocks(message, toolUseIds);
    if (content.length === 0) continue;
    messages.push({ role, content });
  }

  return {
    model: MODEL_ALIASES[request.model] ?? request.model,
    max_tokens: request.max_tokens ?? request.max_completion_tokens ?? 1024,
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    ...(request.stream ? { stream: true } : {}),
    ...(system.length ? { system: system.join("\n\n") } : {}),
    ...(request.tools?.length ? { tools: request.tools.map(toAnthropicTool) } : {}),
    ...(request.tool_choice !== undefined
      ? { tool_choice: toAnthropicToolChoice(request.tool_choice) }
      : {}),
    messages: messages.length
      ? messages
      : [{ role: "user", content: [{ type: "text", text: "" }] }],
  };
}

export function toOpenAiChatCompletion(
  response: AnthropicMessageResponse,
  requestedModel: string,
): unknown {
  const content =
    response.content
      ?.filter((part): part is { type: "text"; text?: string } => part.type === "text")
      .map((part) => part.text ?? "")
      .join("") ?? "";
  const toolCalls =
    response.content
      ?.filter(
        (part): part is Extract<AnthropicContentBlock, { type: "tool_use" }> =>
          part.type === "tool_use",
      )
      .map((part, index) => ({
        id: part.id,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        },
        index,
      })) ?? [];

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    // Echoing the requested name rather than the resolved one: a client that
    // asked for an alias treats the upstream id as a mismatched response.
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason:
          response.stop_reason === "tool_use"
            ? "tool_calls"
            : (response.stop_reason ?? "stop"),
      },
    ],
    usage: {
      prompt_tokens: response.usage?.input_tokens ?? 0,
      completion_tokens: response.usage?.output_tokens ?? 0,
      total_tokens:
        (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    },
  };
}

export async function writeOpenAiStream(
  response: ServerResponse,
  upstream: Response,
  model: string,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.flushHeaders();

  const id = `chatcmpl-${Date.now().toString(36)}`;
  const toolIndexes = new Map<number, number>();
  let nextToolIndex = 0;
  let finishReason: string | null = null;
  writeOpenAiSse(response, id, model, { role: "assistant" }, null);

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Readable.fromWeb(
    upstream.body as import("node:stream/web").ReadableStream,
  )) {
    buffer += decoder.decode(chunk as Buffer, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = parseSseData(event);
      if (!data || data === "[DONE]") continue;
      const parsed = JSON.parse(data) as AnthropicStreamEvent;
      handleAnthropicStreamEvent(response, parsed, {
        id,
        model,
        toolIndexes,
        nextToolIndex: () => nextToolIndex++,
        getFinishReason: () => finishReason,
        setFinishReason: (reason) => {
          finishReason = reason;
        },
      });
    }
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

type AnthropicStreamEvent =
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "text"; text?: string }
        | { type: "tool_use"; id: string; name: string; input?: unknown };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type?: "text_delta"; text?: string }
        | { type?: "input_json_delta"; partial_json?: string };
    }
  | { type: "message_delta"; delta?: { stop_reason?: string | null } }
  | { type: "message_stop" };

function handleAnthropicStreamEvent(
  response: ServerResponse,
  event: AnthropicStreamEvent,
  state: {
    id: string;
    model: string;
    toolIndexes: Map<number, number>;
    nextToolIndex(): number;
    getFinishReason(): string | null;
    setFinishReason(reason: string | null): void;
  },
): void {
  if (event.type === "content_block_start") {
    if (event.content_block.type === "tool_use") {
      const toolIndex = state.nextToolIndex();
      state.toolIndexes.set(event.index, toolIndex);
      writeOpenAiSse(
        response,
        state.id,
        state.model,
        {
          tool_calls: [
            {
              index: toolIndex,
              id: event.content_block.id,
              type: "function",
              function: {
                name: event.content_block.name,
                arguments: hasToolInput(event.content_block.input)
                  ? JSON.stringify(event.content_block.input)
                  : "",
              },
            },
          ],
        },
        null,
      );
    }
    if (event.content_block.type === "text" && event.content_block.text) {
      writeOpenAiSse(
        response,
        state.id,
        state.model,
        { content: event.content_block.text },
        null,
      );
    }
    return;
  }

  if (event.type === "content_block_delta") {
    if ("text" in event.delta && event.delta.text) {
      writeOpenAiSse(
        response,
        state.id,
        state.model,
        { content: event.delta.text },
        null,
      );
    }
    if ("partial_json" in event.delta && event.delta.partial_json) {
      const toolIndex = state.toolIndexes.get(event.index);
      if (toolIndex !== undefined) {
        writeOpenAiSse(
          response,
          state.id,
          state.model,
          {
            tool_calls: [
              {
                index: toolIndex,
                function: { arguments: event.delta.partial_json },
              },
            ],
          },
          null,
        );
      }
    }
    return;
  }

  if (event.type === "message_delta") {
    if (event.delta?.stop_reason) {
      state.setFinishReason(
        event.delta.stop_reason === "tool_use"
          ? "tool_calls"
          : event.delta.stop_reason,
      );
    }
    return;
  }

  if (event.type === "message_stop") {
    writeOpenAiSse(response, state.id, state.model, {}, state.getFinishReason() ?? "stop");
  }
}

function normalizeOpenAiMessages(
  request: OpenAiChatCompletionRequest,
): OpenAiMessage[] {
  if (Array.isArray(request.messages)) return request.messages;

  if (typeof request.input === "string") {
    return [{ role: "user", content: request.input }];
  }

  if (Array.isArray(request.input)) {
    return request.input.flatMap((item): OpenAiMessage[] => {
      if (typeof item === "string") return [{ role: "user", content: item }];
      if (typeof item !== "object" || item === null) return [];
      const source = item as Record<string, unknown>;
      if (typeof source.role === "string") {
        return [
          {
            role: source.role,
            content: source.content,
            ...(typeof source.tool_call_id === "string"
              ? { tool_call_id: source.tool_call_id }
              : {}),
          },
        ];
      }
      if (source.type === "message" && typeof source.role === "string") {
        return [{ role: source.role, content: source.content }];
      }
      if (source.type === "input_text" && typeof source.text === "string") {
        return [{ role: "user", content: source.text }];
      }
      if (
        source.type === "function_call_output" &&
        typeof source.call_id === "string"
      ) {
        return [
          {
            role: "tool",
            tool_call_id: source.call_id,
            content:
              typeof source.output === "string"
                ? source.output
                : JSON.stringify(source.output ?? ""),
          },
        ];
      }
      if (source.type === "function_call" && typeof source.call_id === "string") {
        return [
          {
            role: "assistant",
            tool_calls: [
              {
                id: source.call_id,
                type: "function",
                function: {
                  ...(typeof source.name === "string"
                    ? { name: source.name }
                    : {}),
                  arguments:
                    typeof source.arguments === "string"
                      ? source.arguments
                      : JSON.stringify(source.arguments ?? {}),
                },
              },
            ],
          },
        ];
      }
      return [];
    });
  }

  return [];
}

function toAnthropicContentBlocks(
  message: OpenAiMessage,
  toolUseIds: (id: string) => string,
): AnthropicRequestContent[] {
  const content: AnthropicRequestContent[] = [];
  for (const text of openAiContentToTextParts(message.content)) {
    content.push({ type: "text", text });
  }
  for (const toolCall of message.tool_calls ?? []) {
    const name = toolCall.function?.name;
    if (!name) continue;
    content.push({
      type: "tool_use",
      id: toolUseIds(toolCall.id),
      name,
      input: parseToolArguments(toolCall.function?.arguments),
    });
  }
  return content;
}

function toAnthropicTool(tool: OpenAiTool): unknown {
  return {
    name: tool.function.name,
    ...(tool.function.description
      ? { description: tool.function.description }
      : {}),
    input_schema:
      tool.function.parameters ??
      {
        type: "object",
        properties: {},
      },
  };
}

function toAnthropicToolChoice(choice: OpenAiToolChoice): unknown {
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (choice === "auto") return { type: "auto" };
  return { type: "tool", name: choice.function.name };
}

function parseToolArguments(value: string | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { value };
  }
}

function createToolUseIdMapper(): (id: string) => string {
  const mapped = new Map<string, string>();
  const used = new Set<string>();

  return (id: string): string => {
    const existing = mapped.get(id);
    if (existing) return existing;

    const base = sanitizeToolUseId(id) || `tool_call_${mapped.size + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix++}`;
    }

    mapped.set(id, candidate);
    used.add(candidate);
    return candidate;
  };
}

function sanitizeToolUseId(id: string): string {
  return id
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hasToolInput(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input !== "object") return true;
  return Object.keys(input).length > 0;
}

function stringifyOpenAiContent(content: unknown): string {
  return openAiContentToTextParts(content).join("\n");
}

function openAiContentToTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part !== "object" || part === null) return "";
        const source = part as Record<string, unknown>;
        if (typeof source.text === "string") return source.text;
        if (
          typeof source.type === "string" &&
          source.type === "text" &&
          typeof source.content === "string"
        ) {
          return source.content;
        }
        return "";
      })
      .filter(Boolean);
  }
  return [];
}

function parseSseData(event: string): string {
  return event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("");
}

function writeOpenAiSse(
  response: ServerResponse,
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): void {
  response.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  );
}
