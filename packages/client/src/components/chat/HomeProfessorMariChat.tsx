import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Brain,
  Check,
  Database,
  FileText,
  Link,
  Loader2,
  RefreshCw,
  Send,
  ShieldAlert,
  Square,
  Terminal,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import {
  PROFESSOR_MARI_ID,
  type APIConnection,
  type Chat,
  type MariDbHistoryEntry,
  type MariDbPendingApproval,
  type MariWorkspaceStatus,
  type Message,
} from "@marinara-engine/shared";
import { useConnections } from "../../hooks/use-connections";
import { chatKeys } from "../../hooks/use-chats";
import { filterLanguageGenerationConnections } from "../../lib/connection-filters";
import { api } from "../../lib/api-client";
import { useChatStore } from "../../stores/chat.store";
import { useUIStore } from "../../stores/ui.store";
import { applyInlineMarkdown, renderMarkdownBlocks } from "../../lib/markdown";
import { cn } from "../../lib/utils";
import { ProfessorMariWorkingWindow } from "../ui/ProfessorMariWorkingWindow";
import { HomeFaq } from "./HomeFaq";

const MARI_AVATAR_URL = "/sprites/mari/Mari_profile.png";
const MARI_CHIBI_URL = "/sprites/mari/chibi-professor-mari.png";
const MARI_CONNECTION_STORAGE_KEY = "marinara:home-professor-mari-connection-id";
const MARI_WELCOME =
  "Howdy, welcome to Marinara Engine!\n\nFeeling a little lost? It is not a skill issue yet, I am here to help! Ask me about the app, your setup, or what to do next.\n\nNeed something made or changed? I can create character cards, personas, lorebooks, chats, and presets, and I can make local workspace changes with your approval.";

type WorkspaceApprovalResponse = {
  ok: boolean;
  approval?: MariDbPendingApproval;
  history?: MariDbHistoryEntry | null;
  completed?: boolean;
};

function readStoredConnectionId() {
  try {
    return window.localStorage.getItem(MARI_CONNECTION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberConnectionId(id: string) {
  try {
    window.localStorage.setItem(MARI_CONNECTION_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

function toMessageExtra(message: Message): Message["extra"] {
  if (typeof message.extra === "string") {
    try {
      return JSON.parse(message.extra) as Message["extra"];
    } catch {
      return {
        displayText: null,
        isGenerated: message.role === "assistant",
        tokenCount: null,
        generationInfo: null,
      };
    }
  }
  return message.extra;
}

function createWelcomeMessage(chatId: string | null): Message {
  return {
    id: "__professor_mari_home_welcome__",
    chatId: chatId ?? "__professor_mari_home__",
    role: "assistant",
    characterId: PROFESSOR_MARI_ID,
    content: MARI_WELCOME,
    activeSwipeIndex: 0,
    createdAt: new Date(0).toISOString(),
    extra: {
      displayText: null,
      isGenerated: false,
      tokenCount: null,
      generationInfo: null,
    },
  };
}

function createLocalUserMessage(chatId: string, content: string): Message {
  return {
    id: `__professor_mari_local_${Date.now()}`,
    chatId,
    role: "user",
    characterId: null,
    content,
    activeSwipeIndex: 0,
    createdAt: new Date().toISOString(),
    extra: {
      displayText: null,
      isGenerated: false,
      tokenCount: null,
      generationInfo: null,
    },
  };
}

function getMessageThinking(message: Message): string | null {
  const extra = toMessageExtra(message);
  const thinking = extra?.thinking;
  return typeof thinking === "string" && thinking.trim().length > 0 ? thinking : null;
}

type WorkspaceToolCall = {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  detail: string | null;
  output: string | null;
  updatedAt: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function previewValue(value: unknown, limit = 120): string | null {
  if (value == null) return null;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    const record = asRecord(value);
    if (record) {
      const primary = record.command ?? record.path ?? record.pattern ?? record.query ?? record.url ?? record.reason;
      if (typeof primary === "string") text = primary;
      else {
        try {
          text = JSON.stringify(record);
        } catch {
          text = String(value);
        }
      }
    } else text = String(value);
  }

  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function getToolCallId(data: Record<string, unknown> | null, name: string) {
  const id = data?.id;
  return typeof id === "string" && id.trim() ? id : `${name}-${Date.now()}`;
}

function formatToolName(name: string) {
  return name.replace(/^functions\./, "").replace(/^multi_tool_use\./, "").replace(/_/g, " ");
}

type WorkspaceTimelineItem =
  | { id: string; type: "text"; content: string }
  | { id: string; type: "thinking"; content: string }
  | { id: string; type: "tool"; tool: WorkspaceToolCall }
  | { id: string; type: "status"; content: string };

function timelineId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function appendTextTimeline(current: WorkspaceTimelineItem[], delta: string): WorkspaceTimelineItem[] {
  if (!delta) return current;
  let next = [...current];
  let forceNewText = false;
  for (const segment of delta.split(/(\n{2,})/)) {
    if (!segment) continue;
    if (/^\n{2,}$/.test(segment)) {
      const last = next[next.length - 1];
      if (last?.type === "text") next = [...next.slice(0, -1), { ...last, content: `${last.content}${segment}` }];
      forceNewText = true;
      continue;
    }

    const last = next[next.length - 1];
    if (last?.type === "text" && !forceNewText) {
      next = [...next.slice(0, -1), { ...last, content: `${last.content}${segment}` }];
    } else {
      next = [...next, { id: timelineId("text"), type: "text", content: segment }];
    }
    forceNewText = false;
  }
  return next;
}

function appendThinkingTimeline(current: WorkspaceTimelineItem[], delta: string): WorkspaceTimelineItem[] {
  if (!delta) return current;
  const last = current[current.length - 1];
  if (last?.type === "thinking") return [...current.slice(0, -1), { ...last, content: `${last.content}${delta}` }];
  return [...current, { id: timelineId("thinking"), type: "thinking", content: delta }];
}

function upsertToolTimeline(current: WorkspaceTimelineItem[], update: WorkspaceToolCall): WorkspaceTimelineItem[] {
  const existingIndex = current.findIndex((item) => item.type === "tool" && item.tool.id === update.id);
  if (existingIndex < 0) {
    const toolItem: WorkspaceTimelineItem = { id: `tool-${update.id}`, type: "tool", tool: update };
    return [...current, toolItem];
  }
  return current.map((item, index) => {
    if (index !== existingIndex || item.type !== "tool") return item;
    return {
      ...item,
      tool: {
        ...item.tool,
        ...update,
        name: update.name === "tool" && item.tool.name !== "tool" ? item.tool.name : update.name,
        detail: update.detail ?? item.tool.detail,
        output: update.output ?? item.tool.output,
      },
    };
  });
}

function ToolGlyph({ name, status }: { name: string; status: WorkspaceToolCall["status"] }) {
  if (status === "running") return <Loader2 size="0.72rem" className="animate-spin" />;
  if (status === "error") return <AlertTriangle size="0.72rem" />;
  const lower = name.toLowerCase();
  if (lower.includes("bash") || lower.includes("command")) return <Terminal size="0.72rem" />;
  if (lower.includes("db") || lower.includes("mari")) return <Database size="0.72rem" />;
  if (/(read|write|edit|grep|find|file)/.test(lower)) return <FileText size="0.72rem" />;
  return <Wrench size="0.72rem" />;
}

function CompactMarkdown({ content, streaming }: { content: string; streaming?: boolean }) {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return (
    <div className="mari-message-content text-[0.8125rem] leading-relaxed text-[var(--foreground)] [&_.mari-md-codeblock]:my-2 [&_.mari-md-codeblock]:max-h-44 [&_.mari-md-heading]:mb-1 [&_.mari-md-heading]:mt-2 [&_.mari-md-ol]:my-1.5 [&_.mari-md-ul]:my-1.5">
      {renderMarkdownBlocks(content.trimEnd(), applyInlineMarkdown, "home-mari")}
      {streaming && <span className="ml-1 inline-block h-3 w-1 translate-y-0.5 rounded-full bg-[var(--primary)] opacity-80 animate-pulse" />}
    </div>
  );
}

function MariAvatar({ active }: { active?: boolean }) {
  return (
    <span
      className={cn(
        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-[var(--secondary)] shadow-sm",
        active ? "border-[var(--primary)]/60 shadow-[0_0_14px_rgba(255,179,217,0.22)]" : "border-[var(--border)]/70",
      )}
    >
      <img src={MARI_AVATAR_URL} alt="" className="h-full w-full object-cover" draggable={false} />
    </span>
  );
}

function MariReasoningPanel({ thinking, live, forceOpen }: { thinking: string; live?: boolean; forceOpen?: boolean }) {
  const lineCount = Math.max(1, thinking.trim().split(/\n+/).length);
  return (
    <details open={forceOpen || undefined} className="group text-xs text-[var(--muted-foreground)]">
      <summary className="flex min-h-6 cursor-pointer list-none items-center gap-1.5 font-semibold marker:hidden [&::-webkit-details-marker]:hidden">
        <Brain size="0.72rem" className={cn("shrink-0", live ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]")} />
        <span>Reasoning</span>
        <span className="text-[0.625rem] font-medium opacity-70">
          {live && forceOpen ? "live" : `${lineCount} line${lineCount === 1 ? "" : "s"}`}
        </span>
      </summary>
      <pre className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap break-words py-1 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
        {thinking}
      </pre>
    </details>
  );
}

function TranscriptRow({
  marker,
  children,
  className,
}: {
  marker: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-[2.25rem_minmax(0,1fr)] gap-2", className)}>
      <div className="flex min-w-0 justify-start pt-0.5">{marker}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function WorkspaceToolEvent({ tool }: { tool: WorkspaceToolCall }) {
  const isError = tool.status === "error";
  const isDone = tool.status === "done";
  return (
    <TranscriptRow
      marker={
        <span
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-md",
            isError ? "text-[var(--destructive)]" : isDone ? "text-emerald-400" : "text-[var(--primary)]",
          )}
        >
          <ToolGlyph name={tool.name} status={tool.status} />
        </span>
      }
    >
      <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-[0.7rem] leading-5 text-[var(--muted-foreground)]">
        <span className="shrink-0 font-semibold text-[var(--foreground)]">{formatToolName(tool.name)}</span>
        <span className={cn("shrink-0", isError ? "text-[var(--destructive)]" : isDone ? "text-emerald-400" : "text-[var(--primary)]")}>
          {isError ? "failed" : isDone ? "done" : "running"}
        </span>
        {(tool.detail || tool.output) && <span className="min-w-0 truncate">{tool.output ?? tool.detail}</span>}
      </div>
    </TranscriptRow>
  );
}

function WorkspaceStatusEvent({ content }: { content: string }) {
  return (
    <TranscriptRow
      marker={<Loader2 size="0.78rem" className="mt-1 animate-spin text-[var(--primary)]" />}
      className="text-[0.7rem] text-[var(--muted-foreground)]"
    >
      <span>{content}</span>
    </TranscriptRow>
  );
}

function WorkspaceTimelineEvent({
  item,
  active,
  forceOpenThinking,
}: {
  item: WorkspaceTimelineItem;
  active: boolean;
  forceOpenThinking?: boolean;
}) {
  if (item.type === "text") {
    return (
      <TranscriptRow marker={<MariAvatar active={active} />}>
        <CompactMarkdown content={item.content} streaming={active} />
      </TranscriptRow>
    );
  }
  if (item.type === "thinking") {
    return (
      <TranscriptRow marker={<Brain size="0.78rem" className="mt-1 text-[var(--primary)]" />}>
        <MariReasoningPanel thinking={item.content} live={active} forceOpen={forceOpenThinking} />
      </TranscriptRow>
    );
  }
  if (item.type === "tool") return <WorkspaceToolEvent tool={item.tool} />;
  return <WorkspaceStatusEvent content={item.content} />;
}

function CompactMariMessage({ message, thinking }: { message: Message; thinking?: string | null }) {
  const content = message.content ?? "";

  if (message.role === "user") {
    return (
      <TranscriptRow marker={<span className="pt-0.5 text-[0.6875rem] font-semibold text-[var(--muted-foreground)]">You</span>}>
        <CompactMarkdown content={content} />
      </TranscriptRow>
    );
  }

  return (
    <>
      <TranscriptRow marker={<MariAvatar />}>
        <CompactMarkdown content={content} />
      </TranscriptRow>
      {thinking && (
        <TranscriptRow marker={<Brain size="0.78rem" className="mt-1 text-[var(--muted-foreground)]" />}>
          <MariReasoningPanel thinking={thinking} />
        </TranscriptRow>
      )}
    </>
  );
}

function LoadingHistoryState() {
  return (
    <div className="flex h-full flex-col justify-end gap-2 px-1 pb-2" aria-live="polite">
      <TranscriptRow marker={<MariAvatar active />}>
        <div className="space-y-1.5 py-1">
          <div className="h-2 w-24 rounded-full bg-[var(--muted)]/45 animate-pulse" />
          <div className="h-2 w-full rounded-full bg-[var(--muted)]/35 animate-pulse" />
          <div className="h-2 w-3/4 rounded-full bg-[var(--muted)]/30 animate-pulse" />
        </div>
      </TranscriptRow>
    </div>
  );
}

function ProfessorMariPixelScene({ active }: { active: boolean }) {
  return (
    <div className="mari-professor-pixel-scene" data-state={active ? "active" : "idle"} aria-hidden="true">
      <div data-part="glow" />
      <div data-part="desk" />
      <img src={MARI_CHIBI_URL} alt="" data-part="sprite" draggable={false} />
      <div data-part="laptop">
        <div data-part="screen">
          <span />
          <span />
          <span />
        </div>
        <div data-part="base">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
    </div>
  );
}

function summarizeTables(tables: Record<string, number>) {
  const entries = Object.entries(tables);
  if (entries.length === 0) return "No rows";
  return entries
    .slice(0, 3)
    .map(([table, count]) => `${count} ${table}`)
    .join(", ");
}

function WorkspaceErrorEvent({ message }: { message: string }) {
  return (
    <TranscriptRow marker={<AlertTriangle size="0.8rem" className="mt-1 text-[var(--destructive)]" />}>
      <div className="py-0.5 text-xs text-[var(--destructive)]">{message}</div>
    </TranscriptRow>
  );
}

function WorkspaceApprovalCard({
  approval,
  onApprove,
  onReject,
}: {
  approval: MariDbPendingApproval;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <TranscriptRow marker={<ShieldAlert size="0.85rem" className="mt-1 text-amber-400" />}>
      <div className="border-t border-amber-400/25 py-2 text-xs text-[var(--foreground)]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-semibold">Approve database change</span>
          <span className="rounded-full bg-amber-400/10 px-1.5 py-0.5 text-[0.625rem] text-amber-300">
            {approval.validationStatus}
          </span>
        </div>
        <p className="mt-1 truncate font-mono text-[0.6875rem] text-[var(--muted-foreground)]" title={approval.command}>
          {approval.command}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem] text-[var(--muted-foreground)]">
          <span className="inline-flex items-center gap-1">
            <Database size="0.7rem" /> {summarizeTables(approval.affectedTables)}
          </span>
          <span>
            {approval.affectedRows} row{approval.affectedRows === 1 ? "" : "s"}
          </span>
        </div>
        <div className="mt-2 flex justify-end gap-1.5">
          <button
            type="button"
            onClick={() => onReject(approval.id)}
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[0.6875rem] font-semibold text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => onApprove(approval.id)}
            className="rounded-md bg-[var(--primary)] px-2.5 py-1 text-[0.6875rem] font-semibold text-[var(--primary-foreground)] transition-opacity hover:opacity-90"
          >
            Approve
          </button>
        </div>
      </div>
    </TranscriptRow>
  );
}

export function HomeProfessorMariChat({ pageActive = true }: { pageActive?: boolean }) {
  const qc = useQueryClient();
  const { data: connectionsRaw, isLoading: connectionsLoading } = useConnections();
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(() => readStoredConnectionId());
  const [workspaceStatus, setWorkspaceStatus] = useState<MariWorkspaceStatus | null>(null);
  const [workspaceActive, setWorkspaceActive] = useState(false);
  const [workspaceActivity, setWorkspaceActivity] = useState<string | null>(null);
  const [workspaceTimeline, setWorkspaceTimeline] = useState<WorkspaceTimelineItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [connectionMenuOpen, setConnectionMenuOpen] = useState(false);
  const [faqExpanded, setFaqExpanded] = useState(false);
  const [faqOpenItemId, setFaqOpenItemId] = useState<string | null>("game-mode-model");
  const hasLoadedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const connectionButtonRef = useRef<HTMLButtonElement>(null);
  const connectionMenuRef = useRef<HTMLDivElement>(null);
  const workspaceAbortRef = useRef<AbortController | null>(null);

  const hasActiveGeneration = useChatStore((state) => (chatId ? state.abortControllers.has(chatId) : false));
  const mariPhase = useChatStore((state) => (chatId ? (state.mariPhaseByChatId.get(chatId) ?? null) : null));

  const languageConnections = useMemo(
    () => filterLanguageGenerationConnections((connectionsRaw ?? []) as APIConnection[]),
    [connectionsRaw],
  );
  const selectedConnection = useMemo(
    () => languageConnections.find((connection) => connection.id === selectedConnectionId) ?? null,
    [languageConnections, selectedConnectionId],
  );
  const effectiveConnection =
    selectedConnection ??
    languageConnections.find((connection) => connection.isDefault) ??
    languageConnections[0] ??
    null;
  const effectiveConnectionId = effectiveConnection?.id ?? null;
  const isBusy = sending || hasActiveGeneration || workspaceActive;

  const loadMessages = useCallback(async (id: string) => {
    const items = await api.get<Message[]>(`/chats/${id}/messages?limit=80`);
    setMessages(items.map((message) => ({ ...message, extra: toMessageExtra(message) })));
  }, []);

  const ensureProfessorMariChat = useCallback(
    async (connectionId: string | null) => {
      const params = new URLSearchParams();
      if (connectionId) params.set("connectionId", connectionId);
      const query = params.toString();
      const chat = await api.get<Chat>(`/chats/internal/professor-mari${query ? `?${query}` : ""}`);
      setChatId(chat.id);
      qc.setQueryData(chatKeys.detail(chat.id), chat);
      return chat;
    },
    [qc],
  );

  const refreshWorkspaceStatus = useCallback(async () => {
    const params = new URLSearchParams();
    if (effectiveConnectionId) params.set("connectionId", effectiveConnectionId);
    const query = params.toString();
    const status = await api.get<MariWorkspaceStatus>(`/professor-mari/workspace/status${query ? `?${query}` : ""}`);
    setWorkspaceStatus(status);
    return status;
  }, [effectiveConnectionId]);

  const invalidateWorkspaceData = useCallback(async () => {
    await qc.invalidateQueries({ refetchType: "active" });
  }, [qc]);

  useEffect(() => {
    if (languageConnections.length === 0) {
      setSelectedConnectionId(null);
      return;
    }

    setSelectedConnectionId((current) => {
      if (current && languageConnections.some((connection) => connection.id === current)) return current;
      const next =
        languageConnections.find((connection) => connection.isDefault)?.id ?? languageConnections[0]?.id ?? null;
      if (next) rememberConnectionId(next);
      return next;
    });
  }, [languageConnections]);

  useEffect(() => {
    if (hasLoadedRef.current || connectionsLoading) return;
    hasLoadedRef.current = true;
    setLoadingHistory(true);
    ensureProfessorMariChat(effectiveConnectionId)
      .then((chat) => loadMessages(chat.id))
      .catch((error) => {
        console.error("[Professor Mari] Failed to load home assistant", error);
      })
      .finally(() => setLoadingHistory(false));
  }, [connectionsLoading, effectiveConnectionId, ensureProfessorMariChat, loadMessages]);

  useEffect(() => {
    void refreshWorkspaceStatus().catch(() => {
      setWorkspaceStatus((current) => current && { ...current, error: "Workspace status unavailable" });
    });
    const timer = window.setInterval(() => {
      void refreshWorkspaceStatus().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshWorkspaceStatus]);

  const pendingApprovals = workspaceStatus?.pendingApprovals ?? [];
  const pendingApprovalKey = pendingApprovals.map((approval) => approval.id).join("|");

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, workspaceTimeline, workspaceActivity, pendingApprovalKey, workspaceStatus?.error]);

  const displayMessages = useMemo(() => [createWelcomeMessage(chatId), ...messages], [chatId, messages]);
  const workspaceTimelineActive = workspaceActive || hasActiveGeneration;

  useEffect(() => {
    if (!connectionMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (connectionButtonRef.current?.contains(target) || connectionMenuRef.current?.contains(target)) return;
      setConnectionMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [connectionMenuOpen]);

  const handleConnectionChange = (id: string) => {
    setSelectedConnectionId(id);
    rememberConnectionId(id);
    setConnectionMenuOpen(false);
  };

  const handleRestart = useCallback(async () => {
    const chat = await ensureProfessorMariChat(effectiveConnectionId);
    const currentMessages = await api.get<Message[]>(`/chats/${chat.id}/messages`);
    if (currentMessages.length > 0) {
      await api.post(`/chats/${chat.id}/messages/bulk-delete`, {
        messageIds: currentMessages.map((message) => message.id),
      });
    }
    await api.post("/professor-mari/workspace/reset");
    setMessages([]);
    setDraft("");
    setWorkspaceActive(false);
    setWorkspaceActivity(null);
    useChatStore.getState().clearStreamBuffer(chat.id);
    useChatStore.getState().clearThinkingBuffer(chat.id);
    useChatStore.getState().setAbortController(chat.id, null);
    useChatStore.getState().setMariPhase(chat.id, "idle");
    setWorkspaceTimeline([]);
    await qc.invalidateQueries({ queryKey: chatKeys.messages(chat.id) });
    toast.success("Professor Mari's home chat was restarted.");
  }, [effectiveConnectionId, ensureProfessorMariChat, qc]);

  const runRestart = useCallback(async () => {
    if (isBusy) return;
    setSending(true);
    try {
      await handleRestart();
    } catch (error) {
      console.error("[Professor Mari] Failed to restart", error);
      toast.error("Professor Mari could not restart her notes.");
    } finally {
      setSending(false);
    }
  }, [handleRestart, isBusy]);

  const approveWorkspaceChange = useCallback(
    async (id: string) => {
      const result = await api.post<WorkspaceApprovalResponse>(`/professor-mari/workspace/approvals/${id}/approve`);
      await refreshWorkspaceStatus().catch(() => undefined);
      if (result.history?.status === "approved") {
        await invalidateWorkspaceData();
        toast.success("Workspace change applied. App data refreshed.");
      } else if (result.completed === false) {
        window.setTimeout(() => {
          void invalidateWorkspaceData();
        }, 1500);
      }
    },
    [invalidateWorkspaceData, refreshWorkspaceStatus],
  );

  const rejectWorkspaceChange = useCallback(
    async (id: string) => {
      await api.post(`/professor-mari/workspace/approvals/${id}/reject`);
      await refreshWorkspaceStatus().catch(() => undefined);
    },
    [refreshWorkspaceStatus],
  );

  const stopWorkspace = useCallback(async () => {
    workspaceAbortRef.current?.abort();
    await api.post("/professor-mari/workspace/abort").catch(() => undefined);
  }, []);

  const sendWorkspaceMessage = useCallback(
    async (chat: Chat, text: string) => {
      const controller = new AbortController();
      workspaceAbortRef.current = controller;
      setWorkspaceActive(true);
      setWorkspaceActivity("Thinking...");
      setWorkspaceTimeline([]);
      useChatStore.getState().setAbortController(chat.id, controller);
      useChatStore.getState().clearStreamBuffer(chat.id);
      useChatStore.getState().clearThinkingBuffer(chat.id);
      useChatStore.getState().setMariPhase(chat.id, "thinking");
      let received = false;
      try {
        for await (const event of api.streamEvents(
          "/professor-mari/workspace/prompt",
          { chatId: chat.id, message: text, connectionId: effectiveConnectionId },
          controller.signal,
        )) {
          if (event.type === "token" && typeof event.data === "string") {
            received = true;
            setWorkspaceActivity(null);
            setWorkspaceTimeline((current) => appendTextTimeline(current, event.data as string));
            useChatStore.getState().appendStreamBuffer(event.data, chat.id);
          } else if (event.type === "thinking" && typeof event.data === "string") {
            setWorkspaceTimeline((current) => appendThinkingTimeline(current, event.data as string));
            useChatStore.getState().appendThinkingBuffer(event.data, chat.id);
          } else if (event.type === "tool_start") {
            const data = asRecord(event.data);
            const name = typeof data?.name === "string" ? data.name : "tool";
            const toolCall: WorkspaceToolCall = {
              id: getToolCallId(data, name),
              name,
              status: "running",
              detail: previewValue(data?.input),
              output: null,
              updatedAt: Date.now(),
            };
            setWorkspaceTimeline((current) => upsertToolTimeline(current, toolCall));
            setWorkspaceActivity(`Using ${formatToolName(name)}...`);
            useChatStore.getState().setMariPhase(chat.id, "updating");
          } else if (event.type === "tool_update") {
            const data = asRecord(event.data);
            const name = typeof data?.name === "string" ? data.name : "tool";
            const toolCall: WorkspaceToolCall = {
              id: getToolCallId(data, name),
              name,
              status: "running",
              detail: null,
              output: previewValue(data?.output),
              updatedAt: Date.now(),
            };
            setWorkspaceTimeline((current) => upsertToolTimeline(current, toolCall));
          } else if (event.type === "tool_end") {
            const data = asRecord(event.data);
            const name = typeof data?.name === "string" ? data.name : "tool";
            const isError = data?.isError === true;
            const toolCall: WorkspaceToolCall = {
              id: getToolCallId(data, name),
              name,
              status: isError ? "error" : "done",
              detail: null,
              output: previewValue(data?.output),
              updatedAt: Date.now(),
            };
            setWorkspaceTimeline((current) => upsertToolTimeline(current, toolCall));
            setWorkspaceActivity(isError ? "Tool needs attention" : "Thinking...");
          } else if (event.type === "done") {
            received = true;
          } else if (event.type === "error") {
            throw new Error(typeof event.data === "string" ? event.data : "Workspace generation failed");
          }
        }
      } finally {
        workspaceAbortRef.current = null;
        setWorkspaceActive(false);
        setWorkspaceActivity(null);
        useChatStore.getState().setAbortController(chat.id, null);
        useChatStore.getState().setMariPhase(chat.id, "idle");
      }
      return received;
    },
    [effectiveConnectionId],
  );

  const handleSubmit = async () => {
    const text = draft.trim();
    if (!text || isBusy) return;

    if (text === "/restart") {
      await runRestart();
      return;
    }

    if (!effectiveConnectionId) {
      toast.error("Set up a language connection before asking Professor Mari.");
      useUIStore.getState().openRightPanel("connections");
      return;
    }

    setSending(true);
    try {
      const chat = await ensureProfessorMariChat(effectiveConnectionId);
      setDraft("");
      setMessages((current) => [...current, createLocalUserMessage(chat.id, text)]);
      const received = await sendWorkspaceMessage(chat, text);
      await loadMessages(chat.id);
      useChatStore.getState().clearStreamBuffer(chat.id);
      useChatStore.getState().clearThinkingBuffer(chat.id);
      setWorkspaceTimeline([]);
      await refreshWorkspaceStatus().catch(() => undefined);
      await invalidateWorkspaceData();
      if (!received) toast.error("Professor Mari did not receive a reply from the model.");
    } catch (error) {
      console.error("[Professor Mari] Failed to send", error);
      toast.error("Professor Mari could not answer right now.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <section
        className="home-professor-mari-chat mt-10 w-full max-w-3xl rounded-xl border border-[var(--border)] bg-[var(--card)]/85 shadow-lg shadow-black/10 sm:mt-0"
        data-paused={pageActive ? "false" : "true"}
      >
        <div className="grid gap-2.5 p-2 sm:grid-cols-[minmax(0,0.72fr)_minmax(0,1.45fr)] sm:p-2.5">
          <div className="flex min-w-0 flex-col items-center justify-start gap-2 rounded-lg border border-[var(--border)]/70 bg-[var(--secondary)]/25 p-2.5">
            <div className="w-full max-w-[14rem] [--mari-professor-sprite-bottom:5%]">
              <ProfessorMariPixelScene active={isBusy || mariPhase !== null} />
            </div>
            <div className="hidden sm:block w-full">
              <HomeFaq
                compact
                expanded={faqExpanded}
                onExpandedChange={setFaqExpanded}
                openItemId={faqOpenItemId}
                onOpenItemIdChange={setFaqOpenItemId}
              />
            </div>
          </div>

          <div className="flex h-[clamp(24rem,70dvh,31rem)] min-w-0 flex-col rounded-lg border border-[var(--border)]/70 bg-[var(--background)]/70">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--border)]/60 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs font-semibold text-[var(--foreground)]">Ask Professor Mari</span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {(workspaceActive || hasActiveGeneration) && (
                  <button
                    type="button"
                    onClick={() => void stopWorkspace()}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] text-[var(--destructive)] transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                    title="Stop Professor Mari workspace agent"
                  >
                    <Square size="0.7rem" /> Stop
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void runRestart()}
                  disabled={isBusy}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
                  title="Restart Professor Mari chat"
                >
                  <RefreshCw size="0.75rem" />
                  /restart
                </button>
              </div>
            </div>

            <div ref={scrollRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-2.5 py-3 text-left">
              {loadingHistory ? (
                <LoadingHistoryState />
              ) : (
                <>
                  {displayMessages.map((message) => (
                    <CompactMariMessage
                      key={message.id}
                      message={message}
                      thinking={message.role === "assistant" ? getMessageThinking(message) : null}
                    />
                  ))}
                  {workspaceTimeline.length === 0 && workspaceTimelineActive && (
                    <WorkspaceStatusEvent content={workspaceActivity ?? "Thinking..."} />
                  )}
                  {workspaceTimeline.map((item, index) => {
                    const hasLaterText = workspaceTimeline
                      .slice(index + 1)
                      .some((nextItem) => nextItem.type === "text" && nextItem.content.trim().length > 0);
                    return (
                      <WorkspaceTimelineEvent
                        key={item.id}
                        item={item}
                        active={workspaceTimelineActive}
                        forceOpenThinking={item.type === "thinking" && workspaceTimelineActive && !hasLaterText}
                      />
                    );
                  })}
                  {workspaceStatus?.error && <WorkspaceErrorEvent message={workspaceStatus.error} />}
                  {pendingApprovals.map((approval) => (
                    <WorkspaceApprovalCard
                      key={approval.id}
                      approval={approval}
                      onApprove={(id) => void approveWorkspaceChange(id)}
                      onReject={(id) => void rejectWorkspaceChange(id)}
                    />
                  ))}
                </>
              )}
            </div>

            <form
              className="border-t border-[var(--border)]/60 p-2"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSubmit();
              }}
            >
              <div className="relative flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 shadow-inner shadow-black/10 focus-within:border-[var(--primary)]/50">
                <button
                  ref={connectionButtonRef}
                  type="button"
                  onClick={() => setConnectionMenuOpen((current) => !current)}
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-all",
                    connectionMenuOpen
                      ? "bg-foreground/10 text-foreground/75"
                      : "text-foreground/40 hover:bg-foreground/10 hover:text-foreground/70",
                  )}
                  title={effectiveConnection?.name ? `Connection: ${effectiveConnection.name}` : "Select connection"}
                >
                  <Link size="1rem" />
                </button>

                {connectionMenuOpen && (
                  <div
                    ref={connectionMenuRef}
                    className="absolute bottom-full left-2 z-20 mb-2 flex max-h-72 min-w-[15rem] max-w-[20rem] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-left shadow-2xl"
                  >
                    <div className="border-b border-[var(--border)] px-3 py-2 text-[0.6875rem] font-semibold text-[var(--foreground)]">
                      Connections
                    </div>
                    <div className="overflow-y-auto p-1">
                      {languageConnections.length > 0 ? (
                        languageConnections.map((connection) => {
                          const isActive = effectiveConnectionId === connection.id;
                          return (
                            <button
                              key={connection.id}
                              type="button"
                              onClick={() => handleConnectionChange(connection.id)}
                              className={cn(
                                "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--accent)]",
                                isActive && "font-semibold text-[var(--foreground)]",
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate">{connection.name || connection.id}</span>
                              {isActive && <Check size="0.75rem" className="shrink-0 text-[var(--primary)]" />}
                            </button>
                          );
                        })
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setConnectionMenuOpen(false);
                            useUIStore.getState().openRightPanel("connections");
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                        >
                          <Link size="0.875rem" />
                          Add a connection
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void handleSubmit();
                    }
                  }}
                  rows={1}
                  placeholder="Ask Professor Mari..."
                  className="max-h-24 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm leading-5 text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
                  disabled={isBusy}
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || isBusy}
                  className={cn(
                    "mari-chat-send-btn inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-white transition-all duration-200",
                    draft.trim() && !isBusy ? "hover:text-white active:scale-90" : "cursor-not-allowed opacity-40",
                  )}
                  aria-label="Send to Professor Mari"
                  title="Send"
                >
                  <Send size="0.9375rem" className={cn(draft.trim() && "translate-x-[1px]")} />
                </button>
              </div>
            </form>
          </div>
        </div>
        <div className="sm:hidden px-2 pb-2">
          <HomeFaq
            compact
            expanded={faqExpanded}
            onExpandedChange={setFaqExpanded}
            openItemId={faqOpenItemId}
            onOpenItemIdChange={setFaqOpenItemId}
          />
        </div>
      </section>
      <ProfessorMariWorkingWindow visible={isBusy} />
    </>
  );
}
