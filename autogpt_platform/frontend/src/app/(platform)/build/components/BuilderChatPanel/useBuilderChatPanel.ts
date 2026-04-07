import { postV2CreateSession } from "@/app/api/__generated__/endpoints/chat/chat";
import { getWebSocketToken } from "@/lib/supabase/actions";
import { environment } from "@/services/environment";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEdgeStore } from "../../stores/edgeStore";
import { useNodeStore } from "../../stores/nodeStore";
import {
  GraphAction,
  parseGraphActions,
  serializeGraphForChat,
} from "./helpers";

type SendMessageFn = ReturnType<typeof useChat>["sendMessage"];

export function useBuilderChatPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [sessionError, setSessionError] = useState(false);
  const initializedRef = useRef(false);
  const sendMessageRef = useRef<SendMessageFn | null>(null);

  const nodes = useNodeStore(useShallow((s) => s.nodes));
  const edges = useEdgeStore(useShallow((s) => s.edges));
  const updateNodeData = useNodeStore(useShallow((s) => s.updateNodeData));
  const addEdge = useEdgeStore(useShallow((s) => s.addEdge));

  useEffect(() => {
    if (!isOpen || sessionId || isCreatingSession || sessionError) return;

    async function createSession() {
      setIsCreatingSession(true);
      try {
        const res = await postV2CreateSession(null);
        if (res.status === 200) {
          setSessionId(res.data.id);
        } else {
          setSessionError(true);
        }
      } catch {
        setSessionError(true);
      } finally {
        setIsCreatingSession(false);
      }
    }

    createSession();
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

  useEffect(() => {
    if (!sessionId || !transport || initializedRef.current) return;
    initializedRef.current = true;
    const summary = serializeGraphForChat(nodes, edges);
    sendMessageRef.current?.({
      text: `I'm building an agent in the AutoGPT flow builder. Here's the current graph:\n\n${summary}\n\nWhat does this agent do?`,
    });
  }, [sessionId, transport]);

  function handleToggle() {
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

  const parsedActions = useMemo(() => {
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const last = assistantMessages[assistantMessages.length - 1];
    if (!last) return [];
    const text = last.parts
      .filter(
        (p): p is Extract<typeof p, { type: "text" }> => p.type === "text",
      )
      .map((p) => p.text)
      .join("");
    return parseGraphActions(text);
  }, [messages]);

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
