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
  extractTextFromParts,
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
  const initializedRef = useRef(false);
  const sendMessageRef = useRef<SendMessageFn | null>(null);
  const prevStatusRef = useRef<string>("ready");

  const [{ flowID }] = useQueryStates({ flowID: parseAsString });
  const queryClient = useQueryClient();

  const nodes = useNodeStore(useShallow((s) => s.nodes));
  const edges = useEdgeStore(useShallow((s) => s.edges));
  const updateNodeData = useNodeStore(useShallow((s) => s.updateNodeData));
  const addEdge = useEdgeStore(useShallow((s) => s.addEdge));

  // Reset session and initialized state when the user navigates to a different
  // graph so the new graph's context is sent to the AI on next open.
  useEffect(() => {
    setSessionId(null);
    setSessionError(false);
    initializedRef.current = false;
  }, [flowID]);

  useEffect(() => {
    if (!isOpen || sessionId || isCreatingSession || sessionError) return;

    let cancelled = false;

    async function createSession() {
      setIsCreatingSession(true);
      try {
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
              const messageText =
                last.parts
                  ?.map((p) => (p.type === "text" ? p.text : ""))
                  .join("") ?? "";
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

  const { messages, sendMessage, stop, status } = useChat({
    id: sessionId ?? undefined,
    transport: transport ?? undefined,
  });

  // Keep a stable ref so the initialization effect can call sendMessage
  // without including it in the deps array (avoids re-triggering the effect)
  sendMessageRef.current = sendMessage;

  // Parsed actions from the last assistant message. Placed before the
  // invalidation effect so the effect can check whether a turn mutated the graph.
  const parsedActions = useMemo(() => {
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const last = assistantMessages[assistantMessages.length - 1];
    if (!last) return [];
    const text = extractTextFromParts(last.parts);
    const parsed = parseGraphActions(text);
    const seen = new Set<string>();
    return parsed.filter((action) => {
      const key =
        action.type === "update_node_input"
          ? `${action.nodeId}:${action.key}`
          : `${action.source}:${action.sourceHandle}->${action.target}:${action.targetHandle}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [messages]);

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

  useEffect(() => {
    if (!sessionId || !transport || !isGraphLoaded || initializedRef.current)
      return;
    initializedRef.current = true;
    const summary = serializeGraphForChat(nodes, edges);
    sendMessageRef.current?.({
      text:
        `I'm building an agent in the AutoGPT flow builder. Here's the current graph:\n\n${summary}\n\n` +
        `IMPORTANT: When you modify the graph using edit_agent or fix_agent_graph, you MUST output one JSON ` +
        `code block per change using EXACTLY these formats — no other structure is recognized:\n\n` +
        `To update a node input field:\n` +
        `\`\`\`json\n{"action": "update_node_input", "node_id": "<exact node id>", "key": "<input field name>", "value": <new value>}\n\`\`\`\n\n` +
        `To add a connection between nodes:\n` +
        `\`\`\`json\n{"action": "connect_nodes", "source": "<source node id>", "target": "<target node id>", "source_handle": "<output handle name>", "target_handle": "<input handle name>"}\n\`\`\`\n\n` +
        `Rules: the "action" key is required and must be exactly "update_node_input" or "connect_nodes". ` +
        `Do not use any other field names (e.g. "block", "change", "field", "from", "to" are NOT valid).\n\n` +
        `What does this agent do?`,
    });
  }, [sessionId, transport, isGraphLoaded]);

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
    isCreatingSession,
    sessionError,
    sessionId,
    nodes,
    parsedActions,
    handleApplyAction,
  };
}
