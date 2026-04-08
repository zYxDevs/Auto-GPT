import { postV2CreateSession } from "@/app/api/__generated__/endpoints/chat/chat";
import { getWebSocketToken } from "@/lib/supabase/actions";
import { environment } from "@/services/environment";
import { useToast } from "@/components/molecules/Toast/use-toast";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { MarkerType } from "@xyflow/react";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { parseAsString, useQueryStates } from "nuqs";
import { useShallow } from "zustand/react/shallow";
import { useEdgeStore } from "../../stores/edgeStore";
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

  const nodes = useNodeStore(useShallow((s) => s.nodes));
  const edges = useEdgeStore(useShallow((s) => s.edges));
  const setNodes = useNodeStore((s) => s.setNodes);
  const setEdges = useEdgeStore((s) => s.setEdges);

  // Reset session and seed-sent guard when the user navigates to a different
  // graph so the new graph's context is sent to the AI on next open.
  useEffect(() => {
    setSessionId(null);
    setSessionError(false);
    setAppliedActionKeys(new Set());
    setUndoStack([]);
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
          setSessionId(res.data.id);
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
    if (action.type === "update_node_input") {
      const node = nodes.find((n) => n.id === action.nodeId);
      if (!node) {
        toast({
          title: "Cannot apply change",
          description: `Node "${action.nodeId}" was not found in the graph.`,
          variant: "destructive",
        });
        return;
      }
      // Reject keys not present in the node's input schema to prevent writing
      // arbitrary fields that the block does not support.
      const schemaProps = node.data.inputSchema?.properties;
      if (schemaProps && !(action.key in schemaProps)) {
        toast({
          title: "Cannot apply change",
          description: `Field "${action.key}" is not a valid input for "${getNodeDisplayName(node, node.id)}".`,
          variant: "destructive",
        });
        return;
      }
      // Capture a full nodes snapshot before mutating. Both the apply and the
      // restore use setNodes (not updateNodeData) to bypass the global history
      // store — this keeps chat-panel changes completely separate from Ctrl+Z,
      // preventing the "Applied" badge from going stale after a global undo.
      const prevNodes = useNodeStore.getState().nodes;
      const nextNodes = prevNodes.map((n) =>
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
    } else if (action.type === "connect_nodes") {
      const sourceNode = nodes.find((n) => n.id === action.source);
      const targetNode = nodes.find((n) => n.id === action.target);
      if (!sourceNode || !targetNode) {
        toast({
          title: "Cannot apply connection",
          description: `One or both nodes (${action.source}, ${action.target}) were not found.`,
          variant: "destructive",
        });
        return;
      }
      // Validate that the referenced handles exist on the respective nodes.
      const srcProps = sourceNode.data.outputSchema?.properties;
      const tgtProps = targetNode.data.inputSchema?.properties;
      if (srcProps && !(action.sourceHandle in srcProps)) {
        toast({
          title: "Cannot apply connection",
          description: `Output handle "${action.sourceHandle}" does not exist on "${getNodeDisplayName(sourceNode, action.source)}".`,
          variant: "destructive",
        });
        return;
      }
      if (tgtProps && !(action.targetHandle in tgtProps)) {
        toast({
          title: "Cannot apply connection",
          description: `Input handle "${action.targetHandle}" does not exist on "${getNodeDisplayName(targetNode, action.target)}".`,
          variant: "destructive",
        });
        return;
      }
      const edgeId = `${action.source}:${action.sourceHandle}->${action.target}:${action.targetHandle}`;
      // Capture a full edges snapshot before mutating. Both the apply and the
      // restore use setEdges (not addEdge/removeEdge) to bypass the global
      // history store — keeps chat-panel changes separate from Ctrl+Z.
      const prevEdges = useEdgeStore.getState().edges;
      // Guard against duplicate edges — the same connection may appear after an
      // undo-then-reapply or from identical suggestions across AI messages.
      const alreadyExists = prevEdges.some(
        (e) =>
          e.source === action.source &&
          e.target === action.target &&
          e.sourceHandle === action.sourceHandle &&
          e.targetHandle === action.targetHandle,
      );
      if (alreadyExists) {
        // Edge already present — mark as applied without duplicating it.
        setAppliedActionKeys(
          (prev) => new Set([...prev, getActionKey(action)]),
        );
        return;
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
          // Match the markerEnd style used by addEdge in edgeStore so
          // chat-applied edges render with the same arrowhead as manually drawn ones.
          markerEnd: {
            type: MarkerType.ArrowClosed,
            strokeWidth: 2,
            color: "#555",
          },
        },
      ]);
    } else {
      // Exhaustiveness guard — TypeScript ensures all GraphAction types are handled above.
      const _: never = action;
      return _;
    }
    setAppliedActionKeys((prev) => new Set([...prev, getActionKey(action)]));
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
