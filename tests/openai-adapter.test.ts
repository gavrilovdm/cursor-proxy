import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
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
        "x-anthropic-billing-header: cc_version=2.1.220.5bd; cc_entrypoint=sdk-cli;\n\nPrefer terse answers.",
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
          content: [{ type: "text", text: "Read package metadata." }],
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
      model: "claude-haiku-4-5-20251001",
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
