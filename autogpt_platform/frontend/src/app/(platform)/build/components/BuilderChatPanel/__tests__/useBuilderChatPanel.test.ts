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
const mockSetNodes = vi.fn();
const mockAddEdge = vi.fn();
const mockSetEdges = vi.fn();
const mockRemoveEdge = vi.fn();

vi.mock("../../../stores/nodeStore", () => {
  const useNodeStore = (selector: (s: unknown) => unknown) =>
    selector({
      nodes: mockNodes,
      updateNodeData: mockUpdateNodeData,
      setNodes: mockSetNodes,
    });
  useNodeStore.getState = () => ({
    nodes: mockNodes,
    updateNodeData: mockUpdateNodeData,
    setNodes: mockSetNodes,
  });
  return { useNodeStore };
});

vi.mock("../../../stores/edgeStore", () => {
  const useEdgeStore = (selector: (s: unknown) => unknown) =>
    selector({
      edges: mockEdges,
      addEdge: mockAddEdge,
      setEdges: mockSetEdges,
      removeEdge: mockRemoveEdge,
    });
  useEdgeStore.getState = () => ({
    edges: mockEdges,
    addEdge: mockAddEdge,
    setEdges: mockSetEdges,
    removeEdge: mockRemoveEdge,
  });
  return { useEdgeStore };
});

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

const mockToast = vi.fn();
vi.mock("@/components/molecules/Toast/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

const mockSendMessage = vi.fn();
const mockStop = vi.fn();
let mockChatMessages: unknown[] = [];
let mockChatStatus = "ready";
vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: mockChatMessages,
    sendMessage: mockSendMessage,
    stop: mockStop,
    status: mockChatStatus,
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
  mockChatMessages = [];
  mockChatStatus = "ready";
  mockUpdateNodeData.mockClear();
  mockSetNodes.mockClear();
  mockAddEdge.mockClear();
  mockSetEdges.mockClear();
  mockRemoveEdge.mockClear();
  mockPostV2CreateSession.mockClear();
  mockInvalidateQueries.mockClear();
  mockSendMessage.mockClear();
  mockToast.mockClear();
});

afterEach(() => {
  cleanup();
});

// Flush all pending microtasks + one macrotask so async effects inside `act`
// have time to resolve their awaited promises and commit state updates.
async function openAndFlush(toggle: () => void) {
  await act(async () => {
    toggle();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

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

describe("useBuilderChatPanel – session lifecycle", () => {
  it("creates session and sets sessionId when panel is opened", async () => {
    mockPostV2CreateSession.mockResolvedValue({
      status: 200,
      data: { id: "sess-1" },
    });
    const { result } = renderHook(() => useBuilderChatPanel());

    await openAndFlush(() => result.current.handleToggle());

    expect(mockPostV2CreateSession).toHaveBeenCalledOnce();
    expect(result.current.sessionId).toBe("sess-1");
    expect(result.current.isCreatingSession).toBe(false);
    expect(result.current.sessionError).toBe(false);
  });

  it("sets sessionError when session creation request throws", async () => {
    mockPostV2CreateSession.mockRejectedValue(new Error("network error"));
    const { result } = renderHook(() => useBuilderChatPanel());

    await openAndFlush(() => result.current.handleToggle());

    expect(result.current.sessionError).toBe(true);
    expect(result.current.isCreatingSession).toBe(false);
    expect(result.current.sessionId).toBeNull();
  });

  it("sets sessionError when session creation returns non-200 status", async () => {
    mockPostV2CreateSession.mockResolvedValue({ status: 500, data: {} });
    const { result } = renderHook(() => useBuilderChatPanel());

    await openAndFlush(() => result.current.handleToggle());

    expect(result.current.sessionError).toBe(true);
    expect(result.current.isCreatingSession).toBe(false);
  });

  it("does not create a second session when one already exists", async () => {
    mockPostV2CreateSession.mockResolvedValue({
      status: 200,
      data: { id: "sess-existing" },
    });
    const { result } = renderHook(() => useBuilderChatPanel());

    await openAndFlush(() => result.current.handleToggle());
    expect(mockPostV2CreateSession).toHaveBeenCalledOnce();

    // Close and reopen — should NOT call postV2CreateSession again
    act(() => result.current.handleToggle());
    await openAndFlush(() => result.current.handleToggle());

    expect(mockPostV2CreateSession).toHaveBeenCalledOnce();
    expect(result.current.sessionId).toBe("sess-existing");
  });
});

describe("useBuilderChatPanel – seed message", () => {
  it("sends seed message via sendMessage when session becomes available and isGraphLoaded=true", async () => {
    mockPostV2CreateSession.mockResolvedValue({
      status: 200,
      data: { id: "sess-seed" },
    });
    mockNodes.push({
      id: "n1",
      data: { title: "Search Block", description: "" },
    });

    const { result } = renderHook(() =>
      useBuilderChatPanel({ isGraphLoaded: true }),
    );

    await openAndFlush(() => result.current.handleToggle());

    expect(mockSendMessage).toHaveBeenCalledOnce();
    const callArg = mockSendMessage.mock.calls[0][0] as { text: string };
    expect(callArg.text).toContain("I'm building an agent");
    expect(callArg.text).toContain("graph_context");
  });

  it("does NOT send seed message when isGraphLoaded is false (default)", async () => {
    mockPostV2CreateSession.mockResolvedValue({
      status: 200,
      data: { id: "sess-no-seed" },
    });

    const { result } = renderHook(() => useBuilderChatPanel());

    await openAndFlush(() => result.current.handleToggle());

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("sends seed message only once even when deps re-run (hasSentSeedMessageRef guard)", async () => {
    mockPostV2CreateSession.mockResolvedValue({
      status: 200,
      data: { id: "sess-once" },
    });

    const { result, rerender } = renderHook(() =>
      useBuilderChatPanel({ isGraphLoaded: true }),
    );

    await openAndFlush(() => result.current.handleToggle());
    expect(mockSendMessage).toHaveBeenCalledOnce();

    // Re-render (simulating store update) should not send a second seed
    act(() => rerender());

    expect(mockSendMessage).toHaveBeenCalledOnce();
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

    mockFlowID = "flow-2";
    rerender();

    expect(result.current.sessionId).toBeNull();
  });

  it("resets sessionError when flowID changes", async () => {
    mockPostV2CreateSession.mockRejectedValue(new Error("fail"));
    mockFlowID = "flow-1";

    const { result, rerender } = renderHook(() => useBuilderChatPanel());

    await openAndFlush(() => result.current.handleToggle());
    expect(result.current.sessionError).toBe(true);

    mockFlowID = "flow-2";
    rerender();

    expect(result.current.sessionError).toBe(false);
  });
});

describe("useBuilderChatPanel – apply does not trigger cache refetch", () => {
  it("does NOT call invalidateQueries after applying an update_node_input action (prevents refetch overwriting local state)", () => {
    mockNodes.push({
      id: "n1",
      data: { hardcodedValues: { existing: "val" } },
    });
    mockFlowID = "flow-cache";

    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "update_node_input",
        nodeId: "n1",
        key: "query",
        value: "new val",
      });
    });

    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });
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

  it("update_node_input: shows toast when node not found", () => {
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
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
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

  it("connect_nodes: shows toast and does NOT call addEdge when source node is missing", () => {
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
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("connect_nodes: shows toast and does NOT call addEdge when target node is missing", () => {
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
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("update_node_input: rejects key not present in inputSchema", () => {
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
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
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

  it("connect_nodes: rejects sourceHandle not in outputSchema", () => {
    mockNodes.push(
      { id: "src", data: { outputSchema: { properties: { result: {} } } } },
      { id: "tgt", data: { inputSchema: { properties: { input: {} } } } },
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
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("connect_nodes: rejects targetHandle not in inputSchema", () => {
    mockNodes.push(
      { id: "src", data: { outputSchema: { properties: { result: {} } } } },
      { id: "tgt", data: { inputSchema: { properties: { input: {} } } } },
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
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("connect_nodes: calls addEdge when both handles are valid according to schemas", () => {
    mockNodes.push(
      { id: "src", data: { outputSchema: { properties: { result: {} } } } },
      { id: "tgt", data: { inputSchema: { properties: { input: {} } } } },
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

  it("adds action key to appliedActionKeys after successful apply", () => {
    mockNodes.push({ id: "n1", data: { hardcodedValues: {} } });
    const { result } = renderHook(() => useBuilderChatPanel());

    const action = {
      type: "update_node_input" as const,
      nodeId: "n1",
      key: "query",
      value: "test",
    };

    act(() => {
      result.current.handleApplyAction(action);
    });

    expect(result.current.appliedActionKeys.has('n1:query:"test"')).toBe(true);
  });
});

describe("useBuilderChatPanel – undo", () => {
  it("restores previous node state after undo using setNodes (bypasses history store)", () => {
    const initialNode = {
      id: "node-undo",
      data: { hardcodedValues: { existing: "original" } },
    };
    mockNodes.push(initialNode);

    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "update_node_input",
        nodeId: "node-undo",
        key: "query",
        value: "changed",
      });
    });

    expect(result.current.undoStack).toHaveLength(1);

    // Clear call history so we can verify undo only uses setNodes (not updateNodeData)
    mockUpdateNodeData.mockClear();
    mockSetNodes.mockClear();

    act(() => {
      result.current.handleUndoLastAction();
    });

    // setNodes is called with the captured snapshot to bypass the global history store
    expect(mockSetNodes).toHaveBeenCalledWith([initialNode]);
    // updateNodeData must NOT be called during undo to avoid pushing to history store
    expect(mockUpdateNodeData).not.toHaveBeenCalled();
    expect(result.current.undoStack).toHaveLength(0);
  });

  it("removes action key from appliedActionKeys after undo", () => {
    mockNodes.push({ id: "n-undo", data: { hardcodedValues: {} } });

    const { result } = renderHook(() => useBuilderChatPanel());

    const action = {
      type: "update_node_input" as const,
      nodeId: "n-undo",
      key: "val",
      value: "x",
    };

    act(() => {
      result.current.handleApplyAction(action);
    });
    expect(result.current.appliedActionKeys.size).toBe(1);

    act(() => {
      result.current.handleUndoLastAction();
    });
    expect(result.current.appliedActionKeys.size).toBe(0);
  });

  it("connect_nodes: restores edges via setEdges after undo (bypasses history store)", () => {
    const initialEdge = { id: "existing-edge", source: "a", target: "b" };
    mockEdges.push(initialEdge);
    mockNodes.push({ id: "src", data: {} }, { id: "tgt", data: {} });

    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleApplyAction({
        type: "connect_nodes",
        source: "src",
        target: "tgt",
        sourceHandle: "out",
        targetHandle: "in",
      });
    });

    expect(mockAddEdge).toHaveBeenCalledOnce();
    expect(result.current.undoStack).toHaveLength(1);

    act(() => {
      result.current.handleUndoLastAction();
    });

    // setEdges is called with the captured snapshot to bypass the global history store
    expect(mockSetEdges).toHaveBeenCalledWith([initialEdge]);
    expect(mockRemoveEdge).not.toHaveBeenCalled();
    expect(result.current.undoStack).toHaveLength(0);
    expect(result.current.appliedActionKeys.size).toBe(0);
  });
});

describe("useBuilderChatPanel – parsedActions integration", () => {
  it("returns parsed actions from assistant messages when status is ready", () => {
    mockChatMessages = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: '```json\n{"action":"update_node_input","node_id":"n1","key":"query","value":"AI news"}\n```',
          },
        ],
      },
    ];
    mockChatStatus = "ready";

    const { result } = renderHook(() => useBuilderChatPanel());

    expect(result.current.parsedActions).toHaveLength(1);
    expect(result.current.parsedActions[0]).toEqual({
      type: "update_node_input",
      nodeId: "n1",
      key: "query",
      value: "AI news",
    });
  });

  it("returns empty parsedActions when status is streaming", () => {
    mockChatMessages = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: '```json\n{"action":"update_node_input","node_id":"n1","key":"query","value":"AI news"}\n```',
          },
        ],
      },
    ];
    mockChatStatus = "streaming";

    const { result } = renderHook(() => useBuilderChatPanel());

    expect(result.current.parsedActions).toHaveLength(0);
  });

  it("deduplicates identical actions from multiple assistant messages", () => {
    const actionBlock =
      '```json\n{"action":"update_node_input","node_id":"n1","key":"query","value":"AI news"}\n```';
    mockChatMessages = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: actionBlock }],
      },
      {
        id: "msg-2",
        role: "assistant",
        parts: [{ type: "text", text: actionBlock }],
      },
    ];
    mockChatStatus = "ready";

    const { result } = renderHook(() => useBuilderChatPanel());

    expect(result.current.parsedActions).toHaveLength(1);
  });
});

describe("useBuilderChatPanel – Escape key handler", () => {
  it("closes the panel when Escape is pressed while open", () => {
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.handleToggle();
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("does not error when Escape is pressed while panel is closed", () => {
    const { result } = renderHook(() => useBuilderChatPanel());
    expect(result.current.isOpen).toBe(false);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(result.current.isOpen).toBe(false);
  });
});

describe("useBuilderChatPanel – retrySession", () => {
  it("clears sessionError so the session-creation effect can re-run", async () => {
    mockPostV2CreateSession.mockRejectedValueOnce(new Error("network error"));

    const { result } = renderHook(() => useBuilderChatPanel());

    await openAndFlush(() => result.current.handleToggle());
    expect(result.current.sessionError).toBe(true);

    mockPostV2CreateSession.mockResolvedValue({
      status: 200,
      data: { id: "sess-retry" },
    });

    await act(async () => {
      result.current.retrySession();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.sessionError).toBe(false);
    expect(result.current.sessionId).toBe("sess-retry");
  });
});

describe("useBuilderChatPanel – handleSend", () => {
  it("clears inputValue after sending when session is ready", async () => {
    mockPostV2CreateSession.mockResolvedValue({
      status: 200,
      data: { id: "sess-send" },
    });

    const { result } = renderHook(() => useBuilderChatPanel());

    await openAndFlush(() => result.current.handleToggle());

    act(() => {
      result.current.setInputValue("hello world");
    });

    act(() => {
      result.current.handleSend();
    });

    expect(result.current.inputValue).toBe("");
    expect(mockSendMessage).toHaveBeenCalledWith({ text: "hello world" });
  });

  it("does not send when inputValue is whitespace only", () => {
    const { result } = renderHook(() => useBuilderChatPanel());

    act(() => {
      result.current.setInputValue("   ");
    });

    act(() => {
      result.current.handleSend();
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});
