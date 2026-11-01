import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_BILLING_SYSTEM,
  STRUCTURED_OUTPUT_TOOL,
  toAnthropicMessagesRequest,
  toOpenAiChatCompletion,
  writeOpenAiStream,
} from "../src/proxy/openai-adapter.js";

describe("OpenAI adapter request translation", () => {
  it("maps OpenAI tools and tool messages to Anthropic", () => {
    const request = toAnthropicMessagesRequest({
      model: "cpxopus",
      messages: [
        { role: "developer", content: "Prefer terse answers." },
        { role: "user", content: "Read package metadata." },
        {
          role: "assistant",
          content: "I will inspect it.",
          tool_calls: [
            {
              id: "call_read",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{\"path\":\"package.json\"}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_read",
          content: "{\"name\":\"cursor-proxy\"}",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "read_file" } },
    });

    expect(request).toMatchObject({
      model: "claude-opus-5",
      system:
        "x-anthropic-billing-header: cc_version=2.1.220.5bd; cc_entrypoint=sdk-cli;",
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "read_file" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Prefer terse answers." },
            { type: "text", text: "Read package metadata." },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            {
              type: "tool_use",
              id: "call_read",
              name: "read_file",
              input: { path: "package.json" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_read",
              content: "{\"name\":\"cursor-proxy\"}",
            },
          ],
        },
      ],
    });
  });

  it("accepts Responses API-like input as a fallback", () => {
    const request = toAnthropicMessagesRequest({
      model: "cpxhaiku",
      input: [
        { type: "message", role: "user", content: "Call the helper." },
        {
          type: "function_call",
          call_id: "call_1",
          name: "helper",
          arguments: { value: 1 },
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "done",
        },
      ],
    });

    expect(request).toMatchObject({
      model: "claude-haiku-5-5",
      messages: [
        { role: "user", content: [{ type: "text", text: "Call the helper." }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "helper",
              input: { value: 1 },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "done" },
          ],
        },
      ],
    });
  });

  it("sanitizes OpenAI tool call ids consistently for Anthropic", () => {
    const request = toAnthropicMessagesRequest({
      model: "cpxopus",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call:grep.failed/1",
              type: "function",
              function: {
                name: "grep",
                arguments: "{\"pattern\":\"TODO\"}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call:grep.failed/1",
          content: "grep exited 1",
        },
      ],
    });

    expect(request).toMatchObject({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_grep_failed_1",
              name: "grep",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_grep_failed_1",
              content: "grep exited 1",
            },
          ],
        },
      ],
    });
  });
});

describe("OpenAI adapter finish_reason", () => {
  const cases = [
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["refusal", "content_filter"],
    ["some_future_reason", "stop"],
  ] as const;

  it.each(cases)("maps %s to %s without streaming", (stopReason, finishReason) => {
    const completion = toOpenAiChatCompletion(
      { id: "msg_1", stop_reason: stopReason, content: [{ type: "text", text: "hi" }] },
      "cpxsonnet",
    );

    expect(completion).toMatchObject({ choices: [{ finish_reason: finishReason }] });
  });

  it.each(cases)("maps %s to %s when streaming", async (stopReason, finishReason) => {
    const upstream = new Response(
      `data: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"}}\n\ndata: {"type":"message_stop"}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
    const response = fakeServerResponse();

    await writeOpenAiStream(response, upstream, "cpxsonnet");

    expect(response.body()).toContain(`"finish_reason":"${finishReason}"`);
  });
});

describe("OpenAI adapter response translation", () => {
  it("maps Anthropic tool_use blocks to OpenAI tool_calls", () => {
    expect(
      toOpenAiChatCompletion(
        {
          id: "msg_123",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "I need a file." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "read_file",
              input: { path: "package.json" },
            },
          ],
        },
        "cpxopus",
      ),
    ).toMatchObject({
      model: "cpxopus",
      choices: [
        {
          message: {
            role: "assistant",
            content: "I need a file.",
            tool_calls: [
              {
                id: "toolu_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"package.json\"}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
  });

  it("streams Anthropic tool_use deltas as OpenAI tool_call chunks", async () => {
    const upstream = new Response(
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\""}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"package.json\\"}"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
    const response = fakeServerResponse();

    await writeOpenAiStream(response, upstream, "cpxopus");

    const text = response.body();
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"id":"toolu_1"');
    expect(text).toContain('"name":"read_file"');
    expect(text).toContain('"{\\\"path\\\""');
    expect(text).toContain('":\\\"package.json\\\"}"');
    expect(text).not.toContain('"arguments":"{}"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain("data: [DONE]");
  });
});

describe("OpenAI adapter workarounds for the OAuth upstream", () => {
  it("moves system instructions into the first user turn", () => {
    // Live: a system rule next to the billing marker was ignored, the same rule as user text obeyed.
    const request = toAnthropicMessagesRequest({
      model: "cpxopus",
      messages: [
        { role: "system", content: "Answer with one word." },
        { role: "user", content: "2+2?" },
      ],
    }) as { system: string; messages: unknown[] };

    expect(request.system).toBe(CLAUDE_CODE_BILLING_SYSTEM);
    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Answer with one word." },
          { type: "text", text: "2+2?" },
        ],
      },
    ]);
  });

  it("never prepends instructions to a tool_result turn", () => {
    const request = toAnthropicMessagesRequest({
      model: "cpxopus",
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "system", content: "Be brief." },
      ],
    }) as { messages: Array<{ role: string; content: Array<{ type: string }> }> };

    expect(request.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "Be brief." }] });
    expect(request.messages[2].content[0].type).toBe("tool_result");
  });

  it("drops temperature for models that reject it and keeps it for the rest", () => {
    const opus = toAnthropicMessagesRequest({ model: "cpxopus", temperature: 0.2, messages: [{ role: "user", content: "hi" }] });
    const sonnet = toAnthropicMessagesRequest({ model: "cpxsonnet", temperature: 0.2, messages: [{ role: "user", content: "hi" }] });
    const sonnet5 = toAnthropicMessagesRequest({ model: "claude-sonnet-5", temperature: 0.2, messages: [{ role: "user", content: "hi" }] });
    const haiku = toAnthropicMessagesRequest({ model: "cpxhaiku", temperature: 0.2, messages: [{ role: "user", content: "hi" }] });
    const olderHaiku = toAnthropicMessagesRequest({ model: "claude-haiku-4-5-20251001", temperature: 0.2, messages: [{ role: "user", content: "hi" }] });

    expect(opus).not.toHaveProperty("temperature");
    expect(sonnet).not.toHaveProperty("temperature");
    expect(sonnet5).not.toHaveProperty("temperature");
    expect(haiku).not.toHaveProperty("temperature");
    expect(olderHaiku).toHaveProperty("temperature", 0.2);
  });

  it("resolves the aliases to the current models", () => {
    const modelOf = (alias: string) =>
      (toAnthropicMessagesRequest({ model: alias, messages: [{ role: "user", content: "hi" }] }) as { model: string }).model;

    expect(modelOf("cpxsonnet")).toBe("claude-sonnet-5-5");
    expect(modelOf("cpxhaiku")).toBe("claude-haiku-5-5");
  });

  it("asks for the forced tool in words where the model refuses a forced tool_choice", () => {
    // Live: claude-sonnet-5-5 answers 400 'tool_choice: type "tool" and "any" are not supported'.
    const tool = { type: "function" as const, function: { name: "read_file" } };
    const named = toAnthropicMessagesRequest({
      model: "cpxsonnet",
      messages: [{ role: "user", content: "go" }],
      tools: [tool],
      tool_choice: { type: "function", function: { name: "read_file" } },
    }) as { tool_choice: unknown; messages: Array<{ content: Array<{ text?: string }> }> };
    const required = toAnthropicMessagesRequest({
      model: "cpxsonnet",
      messages: [{ role: "user", content: "go" }],
      tools: [tool],
      tool_choice: "required",
    }) as { tool_choice: unknown; messages: Array<{ content: Array<{ text?: string }> }> };

    expect(named.tool_choice).toEqual({ type: "auto" });
    expect(named.messages[0].content[0].text).toContain("read_file");
    expect(required.tool_choice).toEqual({ type: "auto" });
    expect(required.messages[0].content[0].text).toContain("tools");
  });

  it("asks for the response_format tool in words where the model refuses a forced tool_choice", () => {
    const request = toAnthropicMessagesRequest({
      model: "cpxsonnet",
      messages: [{ role: "user", content: "go" }],
      response_format: { type: "json_object" },
    }) as { tools: Array<{ name: string }>; tool_choice: unknown; messages: Array<{ content: Array<{ text?: string }> }> };

    expect(request.tools.map((tool) => tool.name)).toEqual([STRUCTURED_OUTPUT_TOOL]);
    expect(request.tool_choice).toEqual({ type: "auto" });
    expect(request.messages[0].content[0].text).toContain(STRUCTURED_OUTPUT_TOOL);
  });

  it("keeps a forced tool_choice where the model accepts it", () => {
    const request = toAnthropicMessagesRequest({
      model: "cpxhaiku",
      messages: [{ role: "user", content: "go" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
      tool_choice: { type: "function", function: { name: "read_file" } },
    }) as { tool_choice: unknown; messages: Array<{ content: unknown[] }> };

    expect(request.tool_choice).toEqual({ type: "tool", name: "read_file" });
    expect(request.messages[0].content).toEqual([{ type: "text", text: "go" }]);
  });

  it("drops empty text next to tool calls", () => {
    // Anthropic: 400 "text content blocks must be non-empty".
    const request = toAnthropicMessagesRequest({
      model: "cpxopus",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] },
      ],
    }) as { messages: Array<{ content: Array<{ type: string }> }> };

    expect(request.messages[1].content.map((block) => block.type)).toEqual(["tool_use"]);
  });

  it("turns response_format json_schema into a forced tool", () => {
    const schema = { type: "object", properties: { score: { type: "number" } } };
    const request = toAnthropicMessagesRequest({
      model: "cpxopus",
      messages: [{ role: "user", content: "rate it" }],
      response_format: { type: "json_schema", json_schema: { name: "Rating", schema } },
    });

    expect(request).toMatchObject({
      tools: [{ name: STRUCTURED_OUTPUT_TOOL, input_schema: schema }],
      tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL },
    });
  });

  it("leaves an explicit tool_choice alone when response_format is also set", () => {
    const request = toAnthropicMessagesRequest({
      model: "cpxopus",
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "f" } }],
      tool_choice: "auto",
      response_format: { type: "json_object" },
    }) as { tools: Array<{ name: string }>; tool_choice: unknown };

    expect(request.tools.map((tool) => tool.name)).toEqual(["f"]);
    expect(request.tool_choice).toEqual({ type: "auto" });
  });

  it("returns the structured tool call as message content", () => {
    expect(
      toOpenAiChatCompletion(
        {
          id: "msg_1",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "t1", name: STRUCTURED_OUTPUT_TOOL, input: { score: 7 } }],
        },
        "cpxopus",
      ),
    ).toMatchObject({
      choices: [{ message: { role: "assistant", content: "{\"score\":7}" }, finish_reason: "stop" }],
    });
  });

  it("streams the structured tool call as content deltas", async () => {
    const upstream = new Response(
      [
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"${STRUCTURED_OUTPUT_TOOL}","input":{}}}\n\n`,
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"score\\":7}"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
    const response = fakeServerResponse();

    await writeOpenAiStream(response, upstream, "cpxopus");

    const text = response.body();
    expect(text).not.toContain('"tool_calls"');
    expect(text).toContain('"content":"{\\"score\\":7}"');
    expect(text).toContain('"finish_reason":"stop"');
  });
});

function fakeServerResponse(): PassThrough & {
  writeHead(status: number, headers?: Record<string, string>): void;
  flushHeaders(): void;
  body(): string;
} {
  const chunks: Buffer[] = [];
  const stream = new PassThrough() as PassThrough & {
    writeHead(status: number, headers?: Record<string, string>): void;
    flushHeaders(): void;
    body(): string;
  };
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.writeHead = () => {};
  stream.flushHeaders = () => {};
  stream.body = () => Buffer.concat(chunks).toString("utf8");
  return stream;
}
