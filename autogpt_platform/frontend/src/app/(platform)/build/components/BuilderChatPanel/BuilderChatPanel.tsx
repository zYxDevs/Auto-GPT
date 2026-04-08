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
import ReactMarkdown from "react-markdown";
import type { CustomNode } from "../FlowEditor/nodes/CustomNode/CustomNode";
import { GraphAction, extractTextFromParts, getActionKey } from "./helpers";
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
    error,
    isCreatingSession,
    sessionError,
    sessionId,
    nodes,
    parsedActions,
  } = useBuilderChatPanel({ isGraphLoaded });

  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = status === "streaming" || status === "submitted";
  const canSend =
    Boolean(sessionId) && !isCreatingSession && !sessionError && !isStreaming;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Move focus to the textarea when the panel opens so keyboard users can type immediately.
  useEffect(() => {
    if (isOpen) {
      textareaRef.current?.focus();
    }
  }, [isOpen]);

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

  return (
    <div
      className={cn(
        "pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2",
        className,
      )}
    >
      {isOpen && (
        <div
          role="dialog"
          aria-label="Builder chat panel"
          className="pointer-events-auto flex h-[70vh] w-96 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        >
          <PanelHeader onClose={handleToggle} />

          <MessageList
            messages={messages}
            isCreatingSession={isCreatingSession}
            sessionError={sessionError}
            streamError={error}
            nodes={nodes}
            parsedActions={parsedActions}
            messagesEndRef={messagesEndRef}
          />

          <PanelInput
            value={inputValue}
            onChange={setInputValue}
            onKeyDown={handleKeyDown}
            onSend={handleSend}
            onStop={stop}
            isStreaming={isStreaming}
            isDisabled={!canSend}
            textareaRef={textareaRef}
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
  streamError: Error | undefined;
  nodes: CustomNode[];
  parsedActions: GraphAction[];
  messagesEndRef: React.RefObject<HTMLDivElement>;
}

function MessageList({
  messages,
  isCreatingSession,
  sessionError,
  streamError,
  nodes,
  parsedActions,
  messagesEndRef,
}: MessageListProps) {
  const visibleMessages = messages.filter((msg) =>
    Boolean(extractTextFromParts(msg.parts)),
  );

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Chat messages"
      className="flex-1 space-y-3 overflow-y-auto p-4"
    >
      {isCreatingSession && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <SpinnerGap size={14} className="animate-spin" />
          <span>Setting up chat session...</span>
        </div>
      )}

      {sessionError && (
        <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">
          Failed to start chat session. Please close and try again.
        </div>
      )}

      {streamError && (
        <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">
          Connection error. Please try sending your message again.
        </div>
      )}

      {visibleMessages.length === 0 && !isCreatingSession && !sessionError && (
        <div className="flex flex-col items-center gap-2 py-6 text-center text-xs text-slate-400">
          <ChatCircle size={28} weight="duotone" className="text-violet-300" />
          <p>Ask me to explain or modify your agent.</p>
          <p className="text-slate-300">
            You can say things like &ldquo;What does this agent do?&rdquo; or
            &ldquo;Add a step that formats the output.&rdquo;
          </p>
        </div>
      )}

      {visibleMessages.map((msg) => {
        const textParts = extractTextFromParts(msg.parts);

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
            {msg.role === "assistant" ? (
              <ReactMarkdown
                components={{
                  p: ({ children }) => (
                    <p className="mb-1 last:mb-0">{children}</p>
                  ),
                  code: ({ children }) => (
                    <code className="rounded bg-slate-200 px-1 py-0.5 font-mono text-xs">
                      {children}
                    </code>
                  ),
                  pre: ({ children }) => (
                    <pre className="my-1 overflow-x-auto rounded bg-slate-200 p-2 font-mono text-xs">
                      {children}
                    </pre>
                  ),
                }}
              >
                {textParts}
              </ReactMarkdown>
            ) : (
              textParts
            )}
          </div>
        );
      })}

      {parsedActions.length > 0 && (
        <div className="space-y-2 rounded-lg border border-violet-100 bg-violet-50 p-3">
          <p className="text-xs font-medium text-violet-700">
            AI applied these changes
          </p>
          {parsedActions.map((action) => {
            return (
              <ActionItem
                key={getActionKey(action)}
                action={action}
                nodes={nodes}
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
}: {
  action: GraphAction;
  nodes: CustomNode[];
}) {
  const nodeName = (id: string) =>
    nodes.find((n) => n.id === id)?.data.metadata?.customized_name ||
    nodes.find((n) => n.id === id)?.data.title ||
    id;

  const label =
    action.type === "update_node_input"
      ? `Set "${nodeName(action.nodeId)}" "${action.key}" = ${JSON.stringify(action.value)}`
      : `Connect "${nodeName(action.source)}" -> "${nodeName(action.target)}"`;

  return (
    <div className="flex items-start justify-between gap-2 rounded bg-white p-2 text-xs shadow-sm">
      <span className="leading-tight text-slate-700">{label}</span>
      <span className="shrink-0 rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
        Applied
      </span>
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
  isDisabled: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement>;
}

function PanelInput({
  value,
  onChange,
  onKeyDown,
  onSend,
  onStop,
  isStreaming,
  isDisabled,
  textareaRef,
}: PanelInputProps) {
  return (
    <div className="border-t border-slate-100 p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          disabled={isDisabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about your agent... (Enter to send, Shift+Enter for newline)"
          rows={2}
          className="flex-1 resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-200 disabled:opacity-50"
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
            disabled={isDisabled || !value.trim()}
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
