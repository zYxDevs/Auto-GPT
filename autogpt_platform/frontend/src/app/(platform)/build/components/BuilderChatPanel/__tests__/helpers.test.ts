import { describe, expect, it } from "vitest";
import {
  buildSeedPrompt,
  extractTextFromParts,
  serializeGraphForChat,
} from "../helpers";
import type { CustomNode } from "../../FlowEditor/nodes/CustomNode/CustomNode";

describe("extractTextFromParts", () => {
  it("returns empty string for empty array", () => {
    expect(extractTextFromParts([])).toBe("");
  });

  it("concatenates text parts in order", () => {
    const parts = [
      { type: "text", text: "Hello, " },
      { type: "text", text: "world!" },
    ];
    expect(extractTextFromParts(parts)).toBe("Hello, world!");
  });

  it("ignores non-text parts", () => {
    const parts = [
      { type: "text", text: "visible" },
      { type: "tool-call", text: "ignored" },
      { type: "text", text: " text" },
    ];
    expect(extractTextFromParts(parts)).toBe("visible text");
  });

  it("returns empty string when all parts are non-text", () => {
    const parts = [{ type: "tool-result" }, { type: "image" }];
    expect(extractTextFromParts(parts)).toBe("");
  });
});

describe("buildSeedPrompt", () => {
  it("wraps the summary in <graph_context> tags", () => {
    const result = buildSeedPrompt("some graph summary");
    expect(result).toContain(
      "<graph_context>\nsome graph summary\n</graph_context>",
    );
  });

  it("includes instructions for update_node_input format", () => {
    const result = buildSeedPrompt("");
    expect(result).toContain('"action": "update_node_input"');
  });

  it("includes instructions for connect_nodes format", () => {
    const result = buildSeedPrompt("");
    expect(result).toContain('"action": "connect_nodes"');
  });

  it("ends with a question to prompt AI response", () => {
    const result = buildSeedPrompt("");
    expect(result.trim().endsWith("What does this agent do?")).toBe(true);
  });
});

describe("serializeGraphForChat – XML injection prevention", () => {
  it("escapes < and > in node names before embedding in prompt", () => {
    const nodes = [
      {
        id: "1",
        data: {
          title: "<script>alert(1)</script>",
          description: "",
          hardcodedValues: {},
          inputSchema: {},
          outputSchema: {},
          uiType: 1,
          block_id: "b1",
          costs: [],
          categories: [],
        },
        type: "custom" as const,
        position: { x: 0, y: 0 },
      },
    ] as unknown as CustomNode[];

    const result = serializeGraphForChat(nodes, []);
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("escapes < and > in node descriptions", () => {
    const nodes = [
      {
        id: "1",
        data: {
          title: "Node",
          description: "desc with <injection>",
          hardcodedValues: {},
          inputSchema: {},
          outputSchema: {},
          uiType: 1,
          block_id: "b1",
          costs: [],
          categories: [],
        },
        type: "custom" as const,
        position: { x: 0, y: 0 },
      },
    ] as unknown as CustomNode[];

    const result = serializeGraphForChat(nodes, []);
    expect(result).not.toContain("<injection>");
    expect(result).toContain("&lt;injection&gt;");
  });
});
