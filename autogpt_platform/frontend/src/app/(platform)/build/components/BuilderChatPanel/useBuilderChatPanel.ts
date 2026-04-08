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
  const [appliedActionKeys, setAppliedActionKeys] = useState<Set<string>>(
    new Set(),
  );
  // Guards whether the seed message has been sent for this session.
  const hasSentSeedMessageRef = useRef(false);
  const sendMessageRef = useRef<SendMessageFn | null>(null);

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
    setAppliedActionKeys(new Set());
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

  // ID of the seed message sent on panel open. It contains prompt-engineering
  // instructions that should not be shown to the user.
  const seedMessageId = useMemo(() => {
    if (!hasSentSeedMessageRef.current) return null;
    return messages.find((m) => m.role === "user")?.id ?? null;
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
    function onKeyDown(e: KeyboardEvent) {
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
      // Reject keys not present in the node's input schema to prevent writing
      // arbitrary fields that the block does not support.
      const schemaProps = node.data.inputSchema?.properties;
      if (schemaProps && !(action.key in schemaProps)) return;
      updateNodeData(action.nodeId, {
        hardcodedValues: {
          ...node.data.hardcodedValues,
          [action.key]: action.value,
        },
      });
    } else if (action.type === "connect_nodes") {
      const sourceNode = nodes.find((n) => n.id === action.source);
      const targetNode = nodes.find((n) => n.id === action.target);
      if (!sourceNode || !targetNode) return;
      // Validate that the referenced handles exist on the respective nodes.
      const srcProps = sourceNode.data.outputSchema?.properties;
      const tgtProps = targetNode.data.inputSchema?.properties;
      if (srcProps && !(action.sourceHandle in srcProps)) return;
      if (tgtProps && !(action.targetHandle in tgtProps)) return;
      addEdge({
        id: `${action.source}:${action.sourceHandle}->${action.target}:${action.targetHandle}`,
        source: action.source,
        target: action.target,
        sourceHandle: action.sourceHandle,
        targetHandle: action.targetHandle,
        type: "custom",
      });
    } else {
      return;
    }
    setAppliedActionKeys((prev) => new Set([...prev, getActionKey(action)]));
    if (flowID) {
      queryClient.invalidateQueries({
        queryKey: getGetV1GetSpecificGraphQueryKey(flowID),
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
    appliedActionKeys,
    handleApplyAction,
    seedMessageId,
  };
}
