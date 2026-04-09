import { postV2CreateSession } from "@/app/api/__generated__/endpoints/chat/chat";
import { getWebSocketToken } from "@/lib/supabase/actions";
import { environment } from "@/services/environment";
import { useToast } from "@/components/molecules/Toast/use-toast";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { MarkerType } from "@xyflow/react";
import {
  type Dispatch,
  type SetStateAction,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { parseAsString, useQueryStates } from "nuqs";
import { useShallow } from "zustand/react/shallow";
import { useEdgeStore } from "../../stores/edgeStore";
import type { CustomEdge } from "../FlowEditor/edges/CustomEdge";
import type { CustomNode } from "../FlowEditor/nodes/CustomNode/CustomNode";
import { useNodeStore } from "../../stores/nodeStore";
import {
  GraphAction,
  SEED_PROMPT_PREFIX,
  buildSeedPrompt,
  extractTextFromParts,
  getActionKey,
  getNodeDisplayName,
  parseGraphActions,
  serializeGraphForChat,
} from "./helpers";

type SendMessageFn = ReturnType<typeof useChat>["sendMessage"];

/** Maximum number of undo entries to keep. Oldest entries are dropped when the limit is reached. */
const MAX_UNDO = 20;

/** Snapshot of node data taken before an action is applied, enabling undo. */
interface UndoSnapshot {
  actionKey: string;
  restore: () => void;
}

interface UseBuilderChatPanelArgs {
  isGraphLoaded?: boolean;
}

interface ApplyActionCallbacks {
  toast: ReturnType<typeof useToast>["toast"];
  setNodes: (nodes: CustomNode[]) => void;
  setEdges: (edges: CustomEdge[]) => void;
  setUndoStack: Dispatch<SetStateAction<UndoSnapshot[]>>;
  setAppliedActionKeys: Dispatch<SetStateAction<Set<string>>>;
}

function applyUpdateNodeInput(
  action: Extract<GraphAction, { type: "update_node_input" }>,
  { toast, setNodes, setUndoStack, setAppliedActionKeys }: ApplyActionCallbacks,
): boolean {
  const liveNodes = useNodeStore.getState().nodes;
  const node = liveNodes.find((n) => n.id === action.nodeId);
  if (!node) {
    toast({
      title: "Cannot apply change",
      description: `Node "${action.nodeId}" was not found in the graph.`,
      variant: "destructive",
    });
    return false;
  }
  const schemaProps = node.data.inputSchema?.properties;
  // Use hasOwnProperty to avoid prototype-chain lookups — `in` would allow
  // keys like `__proto__` or `constructor` that sit on Object.prototype.
  if (
    schemaProps &&
    !Object.prototype.hasOwnProperty.call(schemaProps, action.key)
  ) {
    toast({
      title: "Cannot apply change",
      description: `Field "${action.key}" is not a valid input for "${getNodeDisplayName(node, node.id)}".`,
      variant: "destructive",
    });
    return false;
  }
  const prevNodes = [...liveNodes];
  const nextNodes = liveNodes.map((n) =>
    n.id === action.nodeId
      ? {
          ...n,
          data: {
            ...n.data,
            hardcodedValues: {
              ...n.data.hardcodedValues,
              [action.key]: action.value,
            },
          },
        }
      : n,
  );
  const key = getActionKey(action);
  setUndoStack((prev) => {
    const entry: UndoSnapshot = {
      actionKey: key,
      restore: () => {
        setNodes(prevNodes);
        setAppliedActionKeys((keys) => {
          const next = new Set(keys);
          next.delete(key);
          return next;
        });
      },
    };
    const trimmed = prev.length >= MAX_UNDO ? prev.slice(1) : prev;
    return [...trimmed, entry];
  });
  setNodes(nextNodes);
  return true;
}

function applyConnectNodes(
  action: Extract<GraphAction, { type: "connect_nodes" }>,
  { toast, setEdges, setUndoStack, setAppliedActionKeys }: ApplyActionCallbacks,
): boolean {
  const liveNodes = useNodeStore.getState().nodes;
  const sourceNode = liveNodes.find((n) => n.id === action.source);
  const targetNode = liveNodes.find((n) => n.id === action.target);
  if (!sourceNode || !targetNode) {
    toast({
      title: "Cannot apply connection",
      description: `One or both nodes (${action.source}, ${action.target}) were not found.`,
      variant: "destructive",
    });
    return false;
  }
  const srcProps = sourceNode.data.outputSchema?.properties;
  const tgtProps = targetNode.data.inputSchema?.properties;
  // Use hasOwnProperty to prevent prototype-chain bypass (e.g. `__proto__` handle names).
  if (
    srcProps &&
    !Object.prototype.hasOwnProperty.call(srcProps, action.sourceHandle)
  ) {
    toast({
      title: "Cannot apply connection",
      description: `Output handle "${action.sourceHandle}" does not exist on "${getNodeDisplayName(sourceNode, action.source)}".`,
      variant: "destructive",
    });
    return false;
  }
  if (
    tgtProps &&
    !Object.prototype.hasOwnProperty.call(tgtProps, action.targetHandle)
  ) {
    toast({
      title: "Cannot apply connection",
      description: `Input handle "${action.targetHandle}" does not exist on "${getNodeDisplayName(targetNode, action.target)}".`,
      variant: "destructive",
    });
    return false;
  }
  const edgeId = `${action.source}:${action.sourceHandle}->${action.target}:${action.targetHandle}`;
  const prevEdges = [...useEdgeStore.getState().edges];
  const alreadyExists = prevEdges.some(
    (e) =>
      e.source === action.source &&
      e.target === action.target &&
      e.sourceHandle === action.sourceHandle &&
      e.targetHandle === action.targetHandle,
  );
  if (alreadyExists) {
    setAppliedActionKeys((prev) => {
      const next = new Set(prev);
      next.add(getActionKey(action));
      return next;
    });
    return true;
  }
  const key = getActionKey(action);
  setUndoStack((prev) => {
    const entry: UndoSnapshot = {
      actionKey: key,
      restore: () => {
        setEdges(prevEdges);
        setAppliedActionKeys((keys) => {
          const next = new Set(keys);
          next.delete(key);
          return next;
        });
      },
    };
    const trimmed = prev.length >= MAX_UNDO ? prev.slice(1) : prev;
    return [...trimmed, entry];
  });
  setEdges([
    ...prevEdges,
    {
      id: edgeId,
      source: action.source,
      target: action.target,
      sourceHandle: action.sourceHandle,
      targetHandle: action.targetHandle,
      type: "custom",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        strokeWidth: 2,
        color: "#555",
      },
    },
  ]);
  return true;
}

/**
 * Manages the lifecycle and state for the builder chat panel.
 *
 * Responsibilities:
 * - Session creation: creates a chat session when the panel first opens, guarded
 *   against duplicate creation and cleaned up if the component unmounts mid-flight.
 * - Transport: builds a `DefaultChatTransport` once per session, with per-request
 *   auth token refresh via `getWebSocketToken`.
 * - Seed message: sends the serialized graph as context once per session when the
 *   graph finishes loading.
 * - Action parsing: extracts `update_node_input` and `connect_nodes` actions from
 *   completed assistant messages (gated on `status === "ready"`).
 * - Action application: applies validated graph mutations to Zustand stores,
 *   bypassing the global history to keep chat changes separate from Ctrl+Z.
 * - Undo: maintains a bounded LIFO stack (MAX_UNDO = 20) of restore callbacks.
 * - Input: owns the textarea value and keyboard shortcuts (Enter / Shift+Enter / Escape).
 */
export function useBuilderChatPanel({
  isGraphLoaded = false,
}: UseBuilderChatPanelArgs = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [sessionError, setSessionError] = useState(false);
  const [appliedActionKeys, setAppliedActionKeys] = useState<Set<string>>(
    new Set(),
  );
  const [undoStack, setUndoStack] = useState<UndoSnapshot[]>([]);
  // Input state owned here to keep render logic out of the component.
  const [inputValue, setInputValue] = useState("");

  // Guards whether the seed message has been sent for this session.
  const hasSentSeedMessageRef = useRef(false);
  const sendMessageRef = useRef<SendMessageFn | null>(null);
  // Ref-based guard so the session-creation effect doesn't re-run (and cancel
  // the in-flight request) when setIsCreatingSession triggers a re-render.
  const isCreatingSessionRef = useRef(false);

  const [{ flowID }] = useQueryStates({ flowID: parseAsString });
  const { toast } = useToast();

  const nodes = useNodeStore(useShallow((s) => (isOpen ? s.nodes : [])));
  const edges = useEdgeStore(useShallow((s) => (isOpen ? s.edges : [])));
  const setNodes = useNodeStore((s) => s.setNodes);
  const setEdges = useEdgeStore((s) => s.setEdges);

  // Reset session and seed-sent guard when the user navigates to a different
  // graph so the new graph's context is sent to the AI on next open.
  useEffect(() => {
    setSessionId(null);
    setSessionError(false);
    setAppliedActionKeys(new Set());
    setUndoStack([]);
    setInputValue("");
    hasSentSeedMessageRef.current = false;
    // Also reset the creation ref so a new session can be started after
    // navigation, even if one was in-flight when flowID changed.
    isCreatingSessionRef.current = false;
  }, [flowID]);

  useEffect(() => {
    if (!isOpen || sessionId || isCreatingSessionRef.current || sessionError)
      return;
    // The `cancelled` flag prevents state updates after the component unmounts
    // or the effect re-runs, avoiding stale state from async calls.
    let cancelled = false;
    isCreatingSessionRef.current = true;

    async function createSession() {
      setIsCreatingSession(true);
      try {
        // NOTE: The backend validates that the authenticated user owns the
        // session before allowing any messages — session IDs alone are not
        // sufficient for unauthorized access.
        const res = await postV2CreateSession(null);
        if (cancelled) return;
        if (res.status === 200) {
          const id = res.data.id;
          // Validate the session ID is a safe non-empty identifier before
          // interpolating it into the streaming URL — rejects values that
          // contain path-traversal characters or whitespace.
          if (typeof id !== "string" || !id || !/^[\w-]+$/i.test(id)) {
            setSessionError(true);
            return;
          }
          setSessionId(id);
        } else {
          setSessionError(true);
        }
      } catch {
        if (!cancelled) setSessionError(true);
      } finally {
        if (!cancelled) {
          setIsCreatingSession(false);
          isCreatingSessionRef.current = false;
        }
      }
    }

    createSession();
    return () => {
      cancelled = true;
      isCreatingSessionRef.current = false;
    };
    // isCreatingSession is intentionally excluded: the ref guards re-entry so
    // state-driven re-renders don't cancel the in-flight request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, sessionId, sessionError]);

  const transport = useMemo(
    () =>
      sessionId
        ? new DefaultChatTransport({
            api: `${environment.getAGPTServerBaseUrl()}/api/chat/sessions/${sessionId}/stream`,
            prepareSendMessagesRequest: async ({ messages }) => {
              const last = messages[messages.length - 1];
              const { token, error } = await getWebSocketToken();
              if (error || !token)
                throw new Error(
                  "Authentication failed — please sign in again.",
                );
              const messageText = extractTextFromParts(last.parts ?? []);
              return {
                body: {
                  message: messageText,
                  is_user_message: last.role === "user",
                  context: null,
                  file_ids: null,
                  mode: null,
                },
                headers: { Authorization: `Bearer ${token}` },
              };
            },
          })
        : null,
    [sessionId],
  );

  const { messages, setMessages, sendMessage, stop, status, error } = useChat({
    id: sessionId ?? undefined,
    transport: transport ?? undefined,
  });

  // Keep a stable ref so the initialization effect can call sendMessage
  // without including it in the deps array (avoids re-triggering the effect).
  sendMessageRef.current = sendMessage;

  // Clear messages from useChat when navigating to a different graph so stale
  // context from the prior session is not briefly visible in the panel UI.
  useEffect(() => {
    setMessages([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowID]);

  // ID of the seed message sent on panel open. Matched by content prefix rather
  // than message position so user messages are never accidentally suppressed.
  const seedMessageId = useMemo(() => {
    if (!hasSentSeedMessageRef.current) return null;
    return (
      messages.find(
        (m) =>
          m.role === "user" &&
          extractTextFromParts(m.parts).startsWith(SEED_PROMPT_PREFIX),
      )?.id ?? null
    );
  }, [messages]);

  // Parsed actions from all assistant messages, accumulated across turns.
  // Gated on `status === "ready"` so parsing only runs on completed turns.
  const parsedActions = useMemo(() => {
    if (status !== "ready") return [];
    const seen = new Set<string>();
    return messages
      .filter((m) => m.role === "assistant")
      .flatMap((msg) => parseGraphActions(extractTextFromParts(msg.parts)))
      .filter((action) => {
        const key = getActionKey(action);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [messages, status]);

  // Close the panel on Escape so keyboard users can dismiss it quickly.
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  // Send the seed message once per session. `nodes` and `edges` are included in
  // the dep array so this effect always has fresh data; the hasSentSeedMessageRef
  // guard ensures it only fires once even when the store updates.
  useEffect(() => {
    if (
      !sessionId ||
      !transport ||
      !isGraphLoaded ||
      hasSentSeedMessageRef.current
    )
      return;
    hasSentSeedMessageRef.current = true;
    const summary = serializeGraphForChat(nodes, edges);
    sendMessageRef.current?.({ text: buildSeedPrompt(summary) });
  }, [sessionId, transport, isGraphLoaded, nodes, edges]);

  const isStreaming = status === "streaming" || status === "submitted";
  const canSend =
    Boolean(sessionId) && !isCreatingSession && !sessionError && !isStreaming;

  function handleToggle() {
    setIsOpen((o) => !o);
  }

  // Resets session error state so the session-creation effect re-runs on
  // the next render without toggling the panel closed and back open.
  function retrySession() {
    setSessionError(false);
    isCreatingSessionRef.current = false;
  }

  function handleSend() {
    const text = inputValue.trim();
    if (!text || !canSend) return;
    setInputValue("");
    sendMessage({ text });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleApplyAction(action: GraphAction) {
    const cbs: ApplyActionCallbacks = {
      toast,
      setNodes,
      setEdges,
      setUndoStack,
      setAppliedActionKeys,
    };
    let applied = false;
    if (action.type === "update_node_input") {
      applied = applyUpdateNodeInput(action, cbs);
    } else if (action.type === "connect_nodes") {
      applied = applyConnectNodes(action, cbs);
    } else {
      // Exhaustiveness guard — TypeScript ensures all GraphAction types are handled above.
      const _: never = action;
      return _;
    }
    if (applied) {
      setAppliedActionKeys((prev) => {
        const next = new Set(prev);
        next.add(getActionKey(action));
        return next;
      });
    }
  }

  function handleUndoLastAction() {
    // Read the current stack directly rather than inside the setUndoStack updater.
    // Calling restore() (which triggers setNodes/setEdges) inside a state updater
    // is a React anti-pattern — state updaters must be pure. Reading from the ref
    // here is safe because this function is only called from event handlers.
    const stack = undoStack;
    if (stack.length === 0) return;
    const last = stack[stack.length - 1];
    last.restore();
    setUndoStack((prev) => prev.slice(0, -1));
  }

  return {
    isOpen,
    handleToggle,
    retrySession,
    messages,
    stop,
    error,
    isCreatingSession,
    sessionError,
    sessionId,
    nodes,
    parsedActions,
    appliedActionKeys,
    handleApplyAction,
    undoStack,
    handleUndoLastAction,
    seedMessageId,
    // Input handling (owned here to keep component render-only)
    inputValue,
    setInputValue,
    handleSend,
    handleKeyDown,
    isStreaming,
    canSend,
  };
}
