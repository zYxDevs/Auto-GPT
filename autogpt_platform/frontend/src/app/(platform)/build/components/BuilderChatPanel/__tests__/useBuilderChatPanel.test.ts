import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

// --- Module mocks (must be hoisted before imports) ---

// Bypass useShallow's ref-based shallow comparison so selectors work in tests.
vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: (s: unknown) => unknown) => fn,
}));

const mockNodes: unknown[] = [];
const mockEdges: unknown[] = [];
const mockUpdateNodeData = vi.fn();
const mockAddEdge = vi.fn();

vi.mock("../../../stores/nodeStore", () => ({
  useNodeStore: (selector: (s: unknown) => unknown) =>
    selector({
      nodes: mockNodes,
      updateNodeData: mockUpdateNodeData,
    }),
}));

vi.mock("../../../stores/edgeStore", () => ({
  useEdgeStore: (selector: (s: unknown) => unknown) =>
    selector({
      edges: mockEdges,
      addEdge: mockAddEdge,
    }),
}));

const mockPostV2CreateSession = vi.fn();
vi.mock("@/app/api/__generated__/endpoints/chat/chat", () => ({
  postV2CreateSession: (...args: unknown[]) => mockPostV2CreateSession(...args),
}));

vi.mock("@/app/api/__generated__/endpoints/graphs/graphs", () => ({
  getGetV1GetSpecificGraphQueryKey: (id: string) => ["graphs", id],
}));

vi.mock("@/lib/supabase/actions", () => ({
  getWebSocketToken: vi.fn().mockResolvedValue({ token: "tok", error: null }),
}));

vi.mock("@/services/environment", () => ({
  environment: { getAGPTServerBaseUrl: () => "http://localhost:8000" },
}));

const mockInvalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

const mockSendMessage = vi.fn();
const mockStop = vi.fn();
vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: [],
    sendMessage: mockSendMessage,
    stop: mockStop,
    status: "ready",
    error: undefined,
  }),
}));

vi.mock("ai", () => ({
  // Must be a regular function (not an arrow) so it is constructible via `new`.
  DefaultChatTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

let mockFlowID: string | null = null;

vi.mock("nuqs", () => ({
  parseAsString: { withDefault: (d: string) => d },
  useQueryStates: () => [{ flowID: mockFlowID }, vi.fn()],
}));

// Import after mocks
import { useBuilderChatPanel } from "../useBuilderChatPanel";

beforeEach(() => {
  mockFlowID = null;
  mockNodes.length = 0;
  mockEdges.length = 0;
  mockUpdateNodeData.mockClear();
  mockAddEdge.mockClear();
  mockPostV2CreateSession.mockClear();
  mockInvalidateQueries.mockClear();
  mockSendMessage.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("useBuilderChatPanel – handleApplyAction", () => {
  it("update_node_input: calls updateNodeData with merged hardcodedValues", () => {
    mockNodes.push({
      id: "node-1",
      data: { hardcodedValues: { existing: "value" } },
    });
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "update_node_input",
        nodeId: "node-1",
        key: "query",
        value: "AI news",
      });
    });

    expect(mockUpdateNodeData).toHaveBeenCalledWith("node-1", {
      hardcodedValues: { existing: "value", query: "AI news" },
    });
  });

  it("update_node_input: does nothing when node not found", () => {
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "update_node_input",
        nodeId: "nonexistent",
        key: "query",
        value: "test",
      });
    });

    expect(mockUpdateNodeData).not.toHaveBeenCalled();
  });

  it("connect_nodes: calls addEdge when both nodes exist", () => {
    mockNodes.push({ id: "src", data: {} }, { id: "tgt", data: {} });
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "connect_nodes",
        source: "src",
        target: "tgt",
        sourceHandle: "output",
        targetHandle: "input",
      });
    });

    expect(mockAddEdge).toHaveBeenCalledWith({
      id: "src:output->tgt:input",
      source: "src",
      target: "tgt",
      sourceHandle: "output",
      targetHandle: "input",
      type: "custom",
    });
  });

  it("connect_nodes: does NOT call addEdge when source node is missing", () => {
    mockNodes.push({ id: "tgt", data: {} });
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "connect_nodes",
        source: "missing-src",
        target: "tgt",
        sourceHandle: "output",
        targetHandle: "input",
      });
    });

    expect(mockAddEdge).not.toHaveBeenCalled();
  });

  it("connect_nodes: does NOT call addEdge when target node is missing", () => {
    mockNodes.push({ id: "src", data: {} });
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "connect_nodes",
        source: "src",
        target: "missing-tgt",
        sourceHandle: "output",
        targetHandle: "input",
      });
    });

    expect(mockAddEdge).not.toHaveBeenCalled();
  });

  it("update_node_input: rejects key not present in inputSchema when schema is defined", () => {
    mockNodes.push({
      id: "node-1",
      data: {
        hardcodedValues: {},
        inputSchema: { properties: { allowed_key: {} } },
      },
    });
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "update_node_input",
        nodeId: "node-1",
        key: "forbidden_key",
        value: "test",
      });
    });

    expect(mockUpdateNodeData).not.toHaveBeenCalled();
  });

  it("update_node_input: allows key present in inputSchema", () => {
    mockNodes.push({
      id: "node-1",
      data: {
        hardcodedValues: {},
        inputSchema: { properties: { query: {} } },
      },
    });
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "update_node_input",
        nodeId: "node-1",
        key: "query",
        value: "AI news",
      });
    });

    expect(mockUpdateNodeData).toHaveBeenCalledWith("node-1", {
      hardcodedValues: { query: "AI news" },
    });
  });

  it("connect_nodes: rejects sourceHandle not in outputSchema when schema is defined", () => {
    mockNodes.push(
      {
        id: "src",
        data: { outputSchema: { properties: { result: {} } } },
      },
      {
        id: "tgt",
        data: { inputSchema: { properties: { input: {} } } },
      },
    );
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "connect_nodes",
        source: "src",
        target: "tgt",
        sourceHandle: "nonexistent_output",
        targetHandle: "input",
      });
    });

    expect(mockAddEdge).not.toHaveBeenCalled();
  });

  it("connect_nodes: rejects targetHandle not in inputSchema when schema is defined", () => {
    mockNodes.push(
      {
        id: "src",
        data: { outputSchema: { properties: { result: {} } } },
      },
      {
        id: "tgt",
        data: { inputSchema: { properties: { input: {} } } },
      },
    );
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "connect_nodes",
        source: "src",
        target: "tgt",
        sourceHandle: "result",
        targetHandle: "nonexistent_input",
      });
    });

    expect(mockAddEdge).not.toHaveBeenCalled();
  });

  it("connect_nodes: calls addEdge when both handles are valid according to schemas", () => {
    mockNodes.push(
      {
        id: "src",
        data: { outputSchema: { properties: { result: {} } } },
      },
      {
        id: "tgt",
        data: { inputSchema: { properties: { input: {} } } },
      },
    );
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "connect_nodes",
        source: "src",
        target: "tgt",
        sourceHandle: "result",
        targetHandle: "input",
      });
    });

    expect(mockAddEdge).toHaveBeenCalledWith({
      id: "src:result->tgt:input",
      source: "src",
      target: "tgt",
      sourceHandle: "result",
      targetHandle: "input",
      type: "custom",
    });
  });
});

describe("useBuilderChatPanel – initial state", () => {
  it("starts with panel closed and no session", () => {
    const { result } = renderHook(() => useBuilderChatPanel());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.sessionId).toBeNull();
    expect(result.current.sessionError).toBe(false);
    expect(result.current.isCreatingSession).toBe(false);
  });

  it("handleToggle opens and closes the panel", () => {
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleToggle();
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.handleToggle();
    });
    expect(result.current.isOpen).toBe(false);
  });
});

// Flush all pending microtasks + one macrotask so async effects inside `act`
// have time to resolve their awaited promises and commit state updates.
async function openAndFlush(toggle: () => void) {
  await act(async () => {
    toggle();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("useBuilderChatPanel – session lifecycle", () => {
  it("creates session and sets sessionId when panel is opened", async () => {
    mockPostV2CreateSession.mockResolvedValue({
      status: 200,
      data: { id: "sess-1" },
    });
    const { result } = renderHook(() => useBuilderChatPanel());

    await openAndFlush(() => result.current.handleToggle());

    expect(result.current.sessionId).toBe("sess-1");
    expect(result.current.isCreatingSession).toBe(false);
    expect(result.current.sessionError).toBe(false);
  });

  it("sets sessionError when session creation request fails", async () => {
    mockPostV2CreateSession.mockRejectedValue(new Error("network error"));
    const { result } = renderHook(() => useBuilderChatPanel());

    await openAndFlush(() => result.current.handleToggle());

    expect(result.current.sessionError).toBe(true);
    expect(result.current.isCreatingSession).toBe(false);
    expect(result.current.sessionId).toBeNull();
  });

  it("sets sessionError when session creation returns non-200", async () => {
    mockPostV2CreateSession.mockResolvedValue({ status: 500, data: {} });
    const { result } = renderHook(() => useBuilderChatPanel());

    await openAndFlush(() => result.current.handleToggle());

    expect(result.current.sessionError).toBe(true);
  });
});

describe("useBuilderChatPanel – flowID reset", () => {
  it("resets appliedActionKeys when flowID changes", () => {
    mockNodes.push({ id: "n1", data: { hardcodedValues: {} } });
    mockFlowID = "flow-1";

    const { result, rerender } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "update_node_input",
        nodeId: "n1",
        key: "query",
        value: "test",
      });
    });
    expect(result.current.appliedActionKeys.size).toBe(1);

    // Navigate to a different graph
    mockFlowID = "flow-2";
    rerender();

    expect(result.current.appliedActionKeys.size).toBe(0);
  });

  it("resets sessionId when flowID changes", async () => {
    mockPostV2CreateSession.mockResolvedValue({
      status: 200,
      data: { id: "sess-abc" },
    });
    mockFlowID = "flow-1";

    const { result, rerender } = renderHook(() => useBuilderChatPanel());

    await openAndFlush(() => result.current.handleToggle());
    expect(result.current.sessionId).toBe("sess-abc");

    // Navigate to a different graph
    mockFlowID = "flow-2";
    rerender();

    expect(result.current.sessionId).toBeNull();
  });
});
