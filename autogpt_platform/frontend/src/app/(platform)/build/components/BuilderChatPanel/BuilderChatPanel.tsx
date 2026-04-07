"use client";

import { Button } from "@/components/atoms/Button/Button";
import { cn } from "@/lib/utils";
import {
  ChatCircle,
  PaperPlaneTilt,
  SpinnerGap,
  StopCircle,
  X,
} from "@phosphor-icons/react";
import { KeyboardEvent, useEffect, useRef, useState } from "react";
import type { CustomNode } from "../FlowEditor/nodes/CustomNode/CustomNode";
import { GraphAction } from "./helpers";
import { useBuilderChatPanel } from "./useBuilderChatPanel";

interface Props {
  className?: string;
  isGraphLoaded?: boolean;
}

export function BuilderChatPanel({ className, isGraphLoaded }: Props) {
  const {
    isOpen,
    handleToggle,
    messages,
    sendMessage,
    stop,
    status,
    isCreatingSession,
    sessionError,
    nodes,
    parsedActions,
    handleApplyAction,
  } = useBuilderChatPanel({ isGraphLoaded });

  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isStreaming = status === "streaming" || status === "submitted";

  // Scroll to bottom whenever a new message lands (AI response or user send)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  function handleSend() {
    const text = inputValue.trim();
    if (!text || isStreaming) return;
    setInputValue("");
    sendMessage({ text });
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div
      className={cn(
        "pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2",
        className,
      )}
    >
      {isOpen && (
        <div className="pointer-events-auto flex h-[70vh] w-96 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
          <PanelHeader onClose={handleToggle} />

          <MessageList
            messages={messages}
            isCreatingSession={isCreatingSession}
            sessionError={sessionError}
            nodes={nodes}
            parsedActions={parsedActions}
            onApplyAction={handleApplyAction}
            messagesEndRef={messagesEndRef}
          />

          <PanelInput
            value={inputValue}
            onChange={setInputValue}
            onKeyDown={handleKeyDown}
            onSend={handleSend}
            onStop={stop}
            isStreaming={isStreaming}
          />
        </div>
      )}

      <button
        onClick={handleToggle}
        className={cn(
          "pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-colors",
          isOpen
            ? "bg-slate-800 text-white hover:bg-slate-700"
            : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
        )}
        aria-label={isOpen ? "Close chat" : "Chat with builder"}
      >
        {isOpen ? <X size={20} /> : <ChatCircle size={22} weight="fill" />}
      </button>
    </div>
  );
}

function PanelHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
      <div className="flex items-center gap-2">
        <ChatCircle size={18} weight="fill" className="text-violet-600" />
        <span className="text-sm font-semibold text-slate-800">
          Chat with Builder
        </span>
      </div>
      <Button variant="icon" size="icon" onClick={onClose} aria-label="Close">
        <X size={16} />
      </Button>
    </div>
  );
}

interface MessageListProps {
  messages: ReturnType<typeof useBuilderChatPanel>["messages"];
  isCreatingSession: boolean;
  sessionError: boolean;
  nodes: CustomNode[];
  parsedActions: GraphAction[];
  onApplyAction: (action: GraphAction) => void;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}

function MessageList({
  messages,
  isCreatingSession,
  sessionError,
  nodes,
  parsedActions,
  onApplyAction,
  messagesEndRef,
}: MessageListProps) {
  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-4">
      {isCreatingSession && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <SpinnerGap size={14} className="animate-spin" />
          <span>Setting up chat session…</span>
        </div>
      )}

      {sessionError && (
        <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">
          Failed to start chat session. Please close and try again.
        </div>
      )}

      {messages.map((msg) => {
        const textParts = msg.parts
          .filter(
            (p): p is Extract<typeof p, { type: "text" }> => p.type === "text",
          )
          .map((p) => p.text)
          .join("");

        if (!textParts) return null;

        return (
          <div
            key={msg.id}
            className={cn(
              "max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed",
              msg.role === "user"
                ? "ml-auto bg-violet-600 text-white"
                : "bg-slate-100 text-slate-800",
            )}
          >
            {textParts}
          </div>
        );
      })}

      {parsedActions.length > 0 && (
        <div className="space-y-2 rounded-lg border border-violet-100 bg-violet-50 p-3">
          <p className="text-xs font-medium text-violet-700">
            AI applied these changes
          </p>
          {parsedActions.map((action) => {
            const key =
              action.type === "update_node_input"
                ? `${action.nodeId}:${action.key}`
                : `${action.source}:${action.sourceHandle}->${action.target}:${action.targetHandle}`;
            return (
              <ActionItem
                key={key}
                action={action}
                nodes={nodes}
                onApply={() => onApplyAction(action)}
              />
            );
          })}
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}

function ActionItem({
  action,
  nodes,
  onApply,
}: {
  action: GraphAction;
  nodes: CustomNode[];
  onApply: () => void;
}) {
  const [applied, setApplied] = useState(true);

  function handleApply() {
    onApply();
    setApplied(true);
  }

  const nodeName = (id: string) =>
    nodes.find((n) => n.id === id)?.data.title ?? id;

  const label =
    action.type === "update_node_input"
      ? `Set "${nodeName(action.nodeId)}" "${action.key}" = ${JSON.stringify(action.value)}`
      : `Connect "${nodeName(action.source)}" → "${nodeName(action.target)}"`;

  return (
    <div className="flex items-start justify-between gap-2 rounded bg-white p-2 text-xs shadow-sm">
      <span className="leading-tight text-slate-700">{label}</span>
      <button
        onClick={handleApply}
        disabled={applied}
        className={cn(
          "shrink-0 rounded px-2 py-0.5 text-xs font-medium transition-colors",
          applied
            ? "bg-green-100 text-green-700"
            : "bg-violet-600 text-white hover:bg-violet-700",
        )}
      >
        {applied ? "Applied" : "Apply"}
      </button>
    </div>
  );
}

interface PanelInputProps {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  isStreaming: boolean;
}

function PanelInput({
  value,
  onChange,
  onKeyDown,
  onSend,
  onStop,
  isStreaming,
}: PanelInputProps) {
  return (
    <div className="border-t border-slate-100 p-3">
      <div className="flex items-end gap-2">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about your agent…"
          rows={2}
          className="flex-1 resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-200"
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-100 text-red-600 transition-colors hover:bg-red-200"
            aria-label="Stop"
          >
            <StopCircle size={18} />
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={!value.trim()}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600 text-white transition-colors hover:bg-violet-700 disabled:opacity-40"
            aria-label="Send"
          >
            <PaperPlaneTilt size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
