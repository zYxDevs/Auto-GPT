import {
  render,
  screen,
  fireEvent,
  cleanup,
} from "@/tests/integrations/test-utils";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BuilderChatPanel } from "../BuilderChatPanel";
import {
  serializeGraphForChat,
  parseGraphActions,
  getActionKey,
} from "../helpers";
import type { CustomNode } from "../../FlowEditor/nodes/CustomNode/CustomNode";
import type { CustomEdge } from "../../FlowEditor/edges/CustomEdge";

// Mock the hook so we isolate the component rendering
vi.mock("../useBuilderChatPanel", () => ({
  useBuilderChatPanel: vi.fn(),
}));

import { useBuilderChatPanel } from "../useBuilderChatPanel";

const mockUseBuilderChatPanel = vi.mocked(useBuilderChatPanel);

function makeMockHook(
  overrides: Partial<ReturnType<typeof useBuilderChatPanel>> = {},
): ReturnType<typeof useBuilderChatPanel> {
  return {
    isOpen: false,
    handleToggle: vi.fn(),
    messages: [],
    sendMessage: vi.fn(),
    stop: vi.fn(),
    status: "ready",
    error: undefined,
    isCreatingSession: false,
    sessionError: false,
    sessionId: null,
    nodes: [],
    parsedActions: [],
    handleApplyAction: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockUseBuilderChatPanel.mockReturnValue(makeMockHook());
});

afterEach(() => {
  cleanup();
});

describe("BuilderChatPanel", () => {
  it("renders the toggle button when closed", () => {
    render(<BuilderChatPanel />);
    expect(screen.getByLabelText("Chat with builder")).toBeDefined();
  });

  it("does not render the panel content when closed", () => {
    render(<BuilderChatPanel />);
    expect(screen.queryByText("Chat with Builder")).toBeNull();
  });

  it("calls handleToggle when the toggle button is clicked", () => {
    const handleToggle = vi.fn();
    mockUseBuilderChatPanel.mockReturnValue(makeMockHook({ handleToggle }));
    render(<BuilderChatPanel />);
    fireEvent.click(screen.getByLabelText("Chat with builder"));
    expect(handleToggle).toHaveBeenCalledOnce();
  });

  it("renders the panel when isOpen is true", () => {
    mockUseBuilderChatPanel.mockReturnValue(makeMockHook({ isOpen: true }));
    render(<BuilderChatPanel />);
    expect(screen.getByText("Chat with Builder")).toBeDefined();
  });

  it("shows creating session indicator when isCreatingSession is true", () => {
    mockUseBuilderChatPanel.mockReturnValue(
      makeMockHook({ isOpen: true, isCreatingSession: true }),
    );
    render(<BuilderChatPanel />);
    expect(screen.getByText(/Setting up chat session/i)).toBeDefined();
  });

  it("shows welcome/empty state when there are no messages", () => {
    mockUseBuilderChatPanel.mockReturnValue(
      makeMockHook({ isOpen: true, messages: [] }),
    );
    render(<BuilderChatPanel />);
    expect(
      screen.getByText(/Ask me to explain or modify your agent/i),
    ).toBeDefined();
  });

  it("renders user and assistant messages", () => {
    mockUseBuilderChatPanel.mockReturnValue(
      makeMockHook({
        isOpen: true,
        messages: [
          {
            id: "1",
            role: "user",
            parts: [{ type: "text", text: "What does this agent do?" }],
          },
          {
            id: "2",
            role: "assistant",
            parts: [{ type: "text", text: "This agent searches the web." }],
          },
        ] as ReturnType<typeof useBuilderChatPanel>["messages"],
      }),
    );
    render(<BuilderChatPanel />);
    expect(screen.getByText("What does this agent do?")).toBeDefined();
    expect(screen.getByText("This agent searches the web.")).toBeDefined();
  });

  it("renders applied actions section when parsedActions are present", () => {
    mockUseBuilderChatPanel.mockReturnValue(
      makeMockHook({
        isOpen: true,
        parsedActions: [
          {
            type: "update_node_input",
            nodeId: "1",
            key: "query",
            value: "AI news",
          },
        ],
      }),
    );
    render(<BuilderChatPanel />);
    expect(screen.getByText("AI applied these changes")).toBeDefined();
    expect(screen.getByText("Applied")).toBeDefined();
  });

  it("shows applied badge for actions", () => {
    const action = {
      type: "update_node_input" as const,
      nodeId: "1",
      key: "query",
      value: "AI news",
    };
    mockUseBuilderChatPanel.mockReturnValue(
      makeMockHook({
        isOpen: true,
        parsedActions: [action],
      }),
    );
    render(<BuilderChatPanel />);
    expect(screen.getByText("Applied")).toBeDefined();
  });

  it("calls sendMessage when the user submits a message", () => {
    const sendMessage = vi.fn();
    mockUseBuilderChatPanel.mockReturnValue(
      makeMockHook({ isOpen: true, sessionId: "sess-1", sendMessage }),
    );
    render(<BuilderChatPanel />);
    const textarea = screen.getByPlaceholderText(/Ask about your agent/i);
    fireEvent.change(textarea, { target: { value: "Add a summarizer block" } });
    fireEvent.click(screen.getByLabelText("Send"));
    expect(sendMessage).toHaveBeenCalledWith({
      text: "Add a summarizer block",
    });
  });

  it("sends message when Enter is pressed", () => {
    const sendMessage = vi.fn();
    mockUseBuilderChatPanel.mockReturnValue(
      makeMockHook({ isOpen: true, sessionId: "sess-1", sendMessage }),
    );
    render(<BuilderChatPanel />);
    const textarea = screen.getByPlaceholderText(/Ask about your agent/i);
    fireEvent.change(textarea, { target: { value: "Explain this agent" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(sendMessage).toHaveBeenCalledWith({ text: "Explain this agent" });
  });

  it("does NOT send message when Shift+Enter is pressed", () => {
    const sendMessage = vi.fn();
    mockUseBuilderChatPanel.mockReturnValue(
      makeMockHook({ isOpen: true, sessionId: "sess-1", sendMessage }),
    );
    render(<BuilderChatPanel />);
    const textarea = screen.getByPlaceholderText(/Ask about your agent/i);
    fireEvent.change(textarea, { target: { value: "Explain this agent" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("shows Stop button when streaming", () => {
    const stop = vi.fn();
    mockUseBuilderChatPanel.mockReturnValue(
      makeMockHook({ isOpen: true, status: "streaming", stop }),
    );
    render(<BuilderChatPanel />);
    expect(screen.getByLabelText("Stop")).toBeDefined();
    fireEvent.click(screen.getByLabelText("Stop"));
    expect(stop).toHaveBeenCalledOnce();
  });

  it("shows stream error when error prop is set", () => {
    mockUseBuilderChatPanel.mockReturnValue(
      makeMockHook({
        isOpen: true,
        error: new Error("Connection failed"),
      }),
    );
    render(<BuilderChatPanel />);
    expect(screen.getByText(/Connection error/i)).toBeDefined();
  });

  it("renders the panel with role=dialog and message list with role=log", () => {
    mockUseBuilderChatPanel.mockReturnValue(makeMockHook({ isOpen: true }));
    render(<BuilderChatPanel />);
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByRole("log")).toBeDefined();
  });
});

describe("serializeGraphForChat", () => {
  it("returns empty message when no nodes", () => {
    const result = serializeGraphForChat([], []);
    expect(result).toBe("The graph is currently empty.");
  });

  it("lists block names and descriptions", () => {
    const nodes = [
      {
        id: "1",
        data: {
          title: "Google Search",
          description: "Searches the web",
          hardcodedValues: {},
          inputSchema: {},
          outputSchema: {},
          uiType: 1,
          block_id: "block-1",
          costs: [],
          categories: [],
        },
        type: "custom" as const,
        position: { x: 0, y: 0 },
      },
    ] as unknown as CustomNode[];

    const result = serializeGraphForChat(nodes, []);
    expect(result).toContain('"Google Search"');
    expect(result).toContain("Searches the web");
  });

  it("prefers metadata.customized_name over title", () => {
    const nodes = [
      {
        id: "1",
        data: {
          title: "Original Title",
          description: "",
          metadata: { customized_name: "My Custom Name" },
          hardcodedValues: {},
          inputSchema: {},
          outputSchema: {},
          uiType: 1,
          block_id: "block-1",
          costs: [],
          categories: [],
        },
        type: "custom" as const,
        position: { x: 0, y: 0 },
      },
    ] as unknown as CustomNode[];

    const result = serializeGraphForChat(nodes, []);
    expect(result).toContain('"My Custom Name"');
    expect(result).not.toContain('"Original Title"');
  });

  it("truncates nodes beyond MAX_NODES limit", () => {
    const nodes = Array.from({ length: 110 }, (_, i) => ({
      id: String(i),
      data: {
        title: `Node ${i}`,
        description: "",
        hardcodedValues: {},
        inputSchema: {},
        outputSchema: {},
        uiType: 1,
        block_id: `block-${i}`,
        costs: [],
        categories: [],
      },
      type: "custom" as const,
      position: { x: 0, y: 0 },
    })) as unknown as CustomNode[];

    const result = serializeGraphForChat(nodes, []);
    expect(result).toContain("10 additional nodes not shown");
  });

  it("lists connections between nodes", () => {
    const nodes = [
      {
        id: "1",
        data: {
          title: "Search",
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
      {
        id: "2",
        data: {
          title: "Formatter",
          description: "",
          hardcodedValues: {},
          inputSchema: {},
          outputSchema: {},
          uiType: 1,
          block_id: "b2",
          costs: [],
          categories: [],
        },
        type: "custom" as const,
        position: { x: 200, y: 0 },
      },
    ] as unknown as CustomNode[];

    const edges = [
      {
        id: "1:result->2:input",
        source: "1",
        target: "2",
        sourceHandle: "result",
        targetHandle: "input",
        type: "custom" as const,
      },
    ] as unknown as CustomEdge[];

    const result = serializeGraphForChat(nodes, edges);
    expect(result).toContain("Connections");
    expect(result).toContain('"Search"');
    expect(result).toContain('"Formatter"');
  });
});

describe("parseGraphActions", () => {
  it("returns empty array for plain text", () => {
    expect(parseGraphActions("This agent searches the web.")).toEqual([]);
  });

  it("parses update_node_input action", () => {
    const text = `
Here is a suggestion:
\`\`\`json
{"action": "update_node_input", "node_id": "1", "key": "query", "value": "AI news"}
\`\`\`
    `;
    const actions = parseGraphActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "update_node_input",
      nodeId: "1",
      key: "query",
      value: "AI news",
    });
  });

  it("parses connect_nodes action", () => {
    const text = `
\`\`\`json
{"action": "connect_nodes", "source": "1", "target": "2", "source_handle": "result", "target_handle": "input"}
\`\`\`
    `;
    const actions = parseGraphActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "connect_nodes",
      source: "1",
      target: "2",
      sourceHandle: "result",
      targetHandle: "input",
    });
  });

  it("parses multiple action blocks in a single message", () => {
    const text = `
Here are the changes:
\`\`\`json
{"action": "update_node_input", "node_id": "1", "key": "query", "value": "AI news"}
\`\`\`
\`\`\`json
{"action": "connect_nodes", "source": "1", "target": "2", "source_handle": "result", "target_handle": "input"}
\`\`\`
    `;
    const actions = parseGraphActions(text);
    expect(actions).toHaveLength(2);
    expect(actions[0].type).toBe("update_node_input");
    expect(actions[1].type).toBe("connect_nodes");
  });

  it("ignores invalid JSON blocks", () => {
    const text = "```json\nnot valid json\n```";
    expect(parseGraphActions(text)).toEqual([]);
  });

  it("ignores blocks without action field", () => {
    const text = '```json\n{"key": "value"}\n```';
    expect(parseGraphActions(text)).toEqual([]);
  });

  it("ignores update_node_input actions with missing required fields", () => {
    const text =
      '```json\n{"action": "update_node_input", "node_id": "1"}\n```';
    expect(parseGraphActions(text)).toEqual([]);
  });

  it("ignores connect_nodes actions with empty handles", () => {
    const text =
      '```json\n{"action": "connect_nodes", "source": "1", "target": "2", "source_handle": "", "target_handle": "input"}\n```';
    expect(parseGraphActions(text)).toEqual([]);
  });

  it("ignores update_node_input with non-primitive value", () => {
    const text =
      '```json\n{"action": "update_node_input", "node_id": "1", "key": "q", "value": {"nested": "object"}}\n```';
    expect(parseGraphActions(text)).toEqual([]);
  });

  it("accepts numeric and boolean primitive values", () => {
    const textNum =
      '```json\n{"action": "update_node_input", "node_id": "1", "key": "count", "value": 42}\n```';
    const textBool =
      '```json\n{"action": "update_node_input", "node_id": "1", "key": "enabled", "value": true}\n```';
    const numAction = parseGraphActions(textNum)[0];
    const boolAction = parseGraphActions(textBool)[0];
    expect(numAction?.type === "update_node_input" && numAction.value).toBe(42);
    expect(boolAction?.type === "update_node_input" && boolAction.value).toBe(
      true,
    );
  });
});

describe("getActionKey", () => {
  it("returns nodeId:key for update_node_input", () => {
    expect(
      getActionKey({
        type: "update_node_input",
        nodeId: "1",
        key: "query",
        value: "test",
      }),
    ).toBe("1:query");
  });

  it("returns source:handle->target:handle for connect_nodes", () => {
    expect(
      getActionKey({
        type: "connect_nodes",
        source: "1",
        target: "2",
        sourceHandle: "result",
        targetHandle: "input",
      }),
    ).toBe("1:result->2:input");
  });
});
