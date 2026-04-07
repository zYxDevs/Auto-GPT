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

  // Refresh the builder canvas after the AI finishes responding. The AI uses
  // edit_agent to modify the graph server-side; invalidating the query causes
  // useFlow.ts to re-fetch and repopulate nodeStore/edgeStore automatically.
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (
      status === "ready" &&
      (prev === "streaming" || prev === "submitted") &&
      flowID
    ) {
      queryClient.invalidateQueries({
        queryKey: getGetV1GetSpecificGraphQueryKey(flowID),
      });
    }
  }, [status, flowID, queryClient]);

  useEffect(() => {
    if (!sessionId || !transport || !isGraphLoaded || initializedRef.current)
      return;
    initializedRef.current = true;
    const summary = serializeGraphForChat(nodes, edges);
    sendMessageRef.current?.({
      text:
        `I'm building an agent in the AutoGPT flow builder. Here's the current graph:\n\n${summary}\n\n` +
        `When you modify the graph using edit_agent or fix_agent_graph, also include a JSON code block ` +
        `for each discrete change so the canvas can display what you did:\n` +
        `- Node input changed: \`\`\`json\n{"action": "update_node_input", "node_id": "<id>", "key": "<field>", "value": <value>}\n\`\`\`\n` +
        `- Connection added: \`\`\`json\n{"action": "connect_nodes", "source": "<id>", "target": "<id>", "source_handle": "<handle>", "target_handle": "<handle>"}\n\`\`\`\n\n` +
        `What does this agent do?`,
    });
  }, [sessionId, transport, isGraphLoaded]);

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
