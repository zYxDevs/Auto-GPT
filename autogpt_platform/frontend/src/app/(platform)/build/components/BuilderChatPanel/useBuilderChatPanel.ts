import { postV2CreateSession } from "@/app/api/__generated__/endpoints/chat/chat";
import { getGetV1GetSpecificGraphQueryKey } from "@/app/api/__generated__/endpoints/graphs/graphs";
import { getWebSocketToken } from "@/lib/supabase/actions";
import { environment } from "@/services/environment";
import { useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseAsString, useQueryStates } from "nuqs";
import { useShallow } from "zustand/react/shallow";
import { useEdgeStore } from "../../stores/edgeStore";
import { useNodeStore } from "../../stores/nodeStore";
import {
  GraphAction,
  buildSeedPrompt,
  extractTextFromParts,
  getActionKey,
  parseGraphActions,
  serializeGraphForChat,
} from "./helpers";

type SendMessageFn = ReturnType<typeof useChat>["sendMessage"];

interface UseBuilderChatPanelArgs {
  isGraphLoaded?: boolean;
}

export function useBuilderChatPanel({
  isGraphLoaded = true,
}: UseBuilderChatPanelArgs = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [sessionError, setSessionError] = useState(false);
  // Guards whether the seed message has been sent for this session.
  const hasSentSeedMessageRef = useRef(false);
  const sendMessageRef = useRef<SendMessageFn | null>(null);
  const prevStatusRef = useRef<string>("ready");

  const [{ flowID }] = useQueryStates({ flowID: parseAsString });
  const queryClient = useQueryClient();

  const nodes = useNodeStore(useShallow((s) => s.nodes));
  const edges = useEdgeStore(useShallow((s) => s.edges));
  const updateNodeData = useNodeStore(useShallow((s) => s.updateNodeData));
  const addEdge = useEdgeStore(useShallow((s) => s.addEdge));

  // Reset session and seed-sent guard when the user navigates to a different
  // graph so the new graph's context is sent to the AI on next open.
  useEffect(() => {
    setSessionId(null);
    setSessionError(false);
    hasSentSeedMessageRef.current = false;
  }, [flowID]);

  useEffect(() => {
    if (!isOpen || sessionId || isCreatingSession || sessionError) return;
    // The `cancelled` flag prevents state updates after the component unmounts
    // or the effect re-runs, avoiding stale state from async calls.
    let cancelled = false;

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
        if (!cancelled) setIsCreatingSession(false);
      }
    }

    createSession();
    return () => {
      cancelled = true;
    };
  }, [isOpen, sessionId, isCreatingSession, sessionError]);

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

  const { messages, sendMessage, stop, status, error } = useChat({
    id: sessionId ?? undefined,
    transport: transport ?? undefined,
  });

  // Keep a stable ref so the initialization effect can call sendMessage
  // without including it in the deps array (avoids re-triggering the effect).
  sendMessageRef.current = sendMessage;

  // Parsed actions from the last assistant message. Gated on `status ===
  // "ready"` so the expensive regex parse only runs once per completed AI turn,
  // not on every streaming chunk.
  const parsedActions = useMemo(() => {
    if (status !== "ready") return [];
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const last = assistantMessages[assistantMessages.length - 1];
    if (!last) return [];
    const text = extractTextFromParts(last.parts);
    const parsed = parseGraphActions(text);
    const seen = new Set<string>();
    return parsed.filter((action) => {
      const key = getActionKey(action);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [messages, status]);

  // Refresh the canvas only when the AI turn actually mutated the graph via
  // edit_agent. Gating on parsedActions.length > 0 avoids an unnecessary
  // refetch after read-only turns (e.g. the initial description response).
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (
      status === "ready" &&
      (prev === "streaming" || prev === "submitted") &&
      flowID &&
      parsedActions.length > 0
    ) {
      queryClient.invalidateQueries({
        queryKey: getGetV1GetSpecificGraphQueryKey(flowID),
      });
    }
  }, [status, flowID, queryClient, parsedActions.length]);

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

  function handleToggle() {
    // Reset session error when reopening so the panel can retry session creation
    if (!isOpen && !sessionId) {
      setSessionError(false);
    }
    setIsOpen((o) => !o);
  }

  function handleApplyAction(action: GraphAction) {
    if (action.type === "update_node_input") {
      const node = nodes.find((n) => n.id === action.nodeId);
      if (!node) return;
      updateNodeData(action.nodeId, {
        hardcodedValues: {
          ...node.data.hardcodedValues,
          [action.key]: action.value,
        },
      });
    } else if (action.type === "connect_nodes") {
      // Validate both nodes exist before adding the edge to prevent dangling edges
      const sourceExists = nodes.some((n) => n.id === action.source);
      const targetExists = nodes.some((n) => n.id === action.target);
      if (!sourceExists || !targetExists) return;
      addEdge({
        id: `${action.source}:${action.sourceHandle}->${action.target}:${action.targetHandle}`,
        source: action.source,
        target: action.target,
        sourceHandle: action.sourceHandle,
        targetHandle: action.targetHandle,
        type: "custom",
      });
    }
  }

  return {
    isOpen,
    handleToggle,
    messages,
    sendMessage,
    stop,
    status,
    error,
    isCreatingSession,
    sessionError,
    sessionId,
    nodes,
    parsedActions,
    handleApplyAction,
  };
}
