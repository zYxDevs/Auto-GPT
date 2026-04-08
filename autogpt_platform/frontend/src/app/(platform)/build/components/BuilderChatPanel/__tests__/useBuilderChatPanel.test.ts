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
  DefaultChatTransport: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("nuqs", () => ({
  parseAsString: { withDefault: (d: string) => d },
  useQueryStates: () => [{ flowID: null }, vi.fn()],
}));

// Import after mocks
import { useBuilderChatPanel } from "../useBuilderChatPanel";

beforeEach(() => {
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
    mockNodes.push({ id: "src" }, { id: "tgt" });
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
    mockNodes.push({ id: "tgt" });
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
    mockNodes.push({ id: "src" });
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
