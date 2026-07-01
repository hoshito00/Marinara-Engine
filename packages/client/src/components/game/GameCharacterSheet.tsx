// ──────────────────────────────────────────────
// Game: Character Sheet Modal
// Architecture: upstream draft/edit system as base,
// Hoshito sub-components and tabs layered on top.
// ──────────────────────────────────────────────
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Check,
  Heart,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Sparkles,
  Star,
  Swords,
  Target,
  Trash2,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import type {
  HoshitoAttribute,
  HoshitoCharacterStats,
  HoshitoDefaultActionType,
  HoshitoDefaultActions,
  HoshitoGrade,
  HoshitoDamageType,
  HoshitoResistanceTier,
  HoshitoMerit,
  HoshitoCoreMerit,
} from "@marinara-engine/shared";
import {
  DEFAULT_DERIVED_STAT_CONFIG,
  HOSHITO_DEFAULT_ACTIONS,
  HOSHITO_GRADE_ORDER,
  HOSHITO_GRADE_VALUES,
  HOSHITO_RESISTANCE_MULTIPLIERS,
} from "@marinara-engine/shared";
import { cn, getAvatarCropStyle, type AvatarCropValue } from "../../lib/utils";
import { DraftNumberInput } from "../ui/DraftNumberInput";
import { NEUTRAL_SURFACE_VARIABLES } from "../ui/neutral-surface-styles";
import {
  createDefaultRpgStatPools,
  normalizeRpgStatPools,
  syncRpgHpFromPools,
  type RPGStatPool,
} from "@marinara-engine/shared";

// ──────────────────────────────────────────────
// Shared type declarations
// ──────────────────────────────────────────────

export interface GameCharacterSheetGameCard {
  shortDescription: string;
  class: string;
  abilities: string[];
  strengths: string[];
  weaknesses: string[];
  extra: Record<string, string>;
  rpgStats?: {
    attributes: Array<{ name: string; value: number }>;
    hp: { value: number; max: number };
    pools?: RPGStatPool[];
  };
}

export interface CharacterSheetCard {
  title: string;
  subtitle?: string;
  mood?: string;
  status?: string;
  level?: number;
  avatarUrl?: string | null;
  avatarCrop?: AvatarCropValue | null;
  stats?: Array<{ name: string; value: number; max?: number; color?: string }>;
  inventory?: Array<{ name: string; quantity?: number; location?: string }>;
  customFields?: Record<string, string>;
  gameCard?: GameCharacterSheetGameCard;
  /** Hoshito ruleset stats — primary source when the Hoshito system is active. */
  hoshitoStats?: HoshitoCharacterStats | null;
}

interface GameCharacterSheetProps {
  card: CharacterSheetCard;
  onClose: () => void;
  onSave?: (
    gameCard: GameCharacterSheetGameCard | undefined,
    hoshitoStats?: HoshitoCharacterStats,
  ) => Promise<void> | void;
  onRegenerate?: () => Promise<void> | void;
  isRegenerating?: boolean;
}

// ──────────────────────────────────────────────
// Upstream draft system (game card editing)
// ──────────────────────────────────────────────

interface GameCardDraft {
  shortDescription: string;
  class: string;
  abilities: string[];
  strengths: string[];
  weaknesses: string[];
  extraEntries: Array<{ key: string; value: string }>;
  rpgStatsEnabled: boolean;
  pools: RPGStatPool[];
  attributes: Array<{ name: string; value: number }>;
  hpValue: number;
  hpMax: number;
  hoshitoEnabled: boolean;
  hoshitoLevel: number;
  hoshitoDomains: HoshitoCharacterStats["domains"];
  hoshitoVerve: number;
  hoshitoStoryPoints: number;
  hoshitoMerits: HoshitoMerit[];
  hoshitoCoreMerits: HoshitoCoreMerit[];
}

type DraftListField = "abilities" | "strengths" | "weaknesses";

const DEFAULT_ATTRIBUTES = [
  { name: "STR", value: 10 },
  { name: "DEX", value: 10 },
  { name: "CON", value: 10 },
  { name: "INT", value: 10 },
  { name: "WIS", value: 10 },
  { name: "CHA", value: 10 },
];

function createNewRpgPool(existing: readonly RPGStatPool[]): RPGStatPool {
  const used = new Set(existing.map((pool) => pool.name.trim().toLowerCase()).filter(Boolean));
  let index = existing.length + 1;
  let name = `Pool ${index}`;
  while (used.has(name.toLowerCase())) {
    name = `Pool ${++index}`;
  }
  return { name, value: 100, max: 100, color: "#a78bfa" };
}

// Mirrors server's attributeModifier in skill-check.service.ts: floor((score - 10) / 2).
function formatAttributeModifier(score: number): string {
  const mod = Math.floor((score - 10) / 2);
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

const FIELD_LABEL_CLASS =
  "text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]";
const TEXT_INPUT_CLASS =
  "w-full rounded-lg border border-[var(--marinara-chat-chrome-input-border)] bg-[var(--marinara-chat-chrome-input-bg)] px-3 py-2 text-sm text-[var(--foreground)] outline-none transition-colors focus:border-[var(--marinara-chat-chrome-input-border-focus)]";
const NUMBER_INPUT_CLASS =
  "w-full rounded-lg border border-transparent bg-[var(--marinara-chat-chrome-input-bg)] px-2.5 py-1.5 text-sm text-[var(--foreground)] outline-none transition-colors focus:border-[var(--marinara-chat-chrome-input-border-focus)]";

function normalizeTextValue(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
function normalizeNumberValue(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function normalizeDraftListSource(value: unknown) {
  const entries = Array.isArray(value)
    ? value.map((e) => normalizeTextValue(e).trim()).filter(Boolean)
    : [];
  return entries.length > 0 ? entries : [""];
}
function normalizeDraftExtraEntries(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [{ key: "", value: "" }];
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => ({ key: normalizeTextValue(k).trim(), value: normalizeTextValue(v).trim() }))
    .filter((e) => e.key || e.value);
  return entries.length > 0 ? entries : [{ key: "", value: "" }];
}
function normalizeDraftAttributes(value: unknown) {
  if (!Array.isArray(value)) return DEFAULT_ATTRIBUTES.map((a) => ({ ...a }));
  const entries = value
    .map((e) => {
      if (!e || typeof e !== "object") return null;
      const raw = e as Record<string, unknown>;
      const name = normalizeTextValue(raw.name).trim();
      if (!name) return null;
      return { name, value: normalizeNumberValue(raw.value, 0) };
    })
    .filter((e): e is { name: string; value: number } => !!e);
  return entries;
}
function createDraft(gameCard?: GameCharacterSheetGameCard, hoshitoStats?: HoshitoCharacterStats | null): GameCardDraft {
  const raw = gameCard as (Record<string, unknown> & { rpgStats?: Record<string, unknown> }) | undefined;
  const rawRpg =
    raw?.rpgStats && typeof raw.rpgStats === "object" && !Array.isArray(raw.rpgStats)
      ? raw.rpgStats
      : undefined;
  const rawHp =
    rawRpg?.hp && typeof rawRpg.hp === "object" && !Array.isArray(rawRpg.hp)
      ? (rawRpg.hp as Record<string, unknown>)
      : undefined;
  const pools = rawRpg
    ? normalizeRpgStatPools(rawRpg as unknown as GameCharacterSheetGameCard["rpgStats"])
    : createDefaultRpgStatPools();
  const hp = syncRpgHpFromPools(pools, {
    value: normalizeNumberValue(rawHp?.value, 100),
    max: Math.max(1, normalizeNumberValue(rawHp?.max, 100)),
  });
  const blankDomain = (name: string): HoshitoCharacterStats["domains"][0] => ({
    name,
    attributes: [{ name: "NEW", grade: "F", sparks: 0, vestigeSparks: 0 }],
  });
  return {
    shortDescription: normalizeTextValue(raw?.shortDescription).trim(),
    class: normalizeTextValue(raw?.class).trim(),
    abilities: normalizeDraftListSource(raw?.abilities),
    strengths: normalizeDraftListSource(raw?.strengths),
    weaknesses: normalizeDraftListSource(raw?.weaknesses),
    extraEntries: normalizeDraftExtraEntries(raw?.extra),
    rpgStatsEnabled: !!rawRpg,
    pools,
    attributes: normalizeDraftAttributes(rawRpg?.attributes),
    hpValue: hp.value,
    hpMax: hp.max,
    hoshitoEnabled: hoshitoStats ? hoshitoStats.enabled !== false : false,
    hoshitoLevel: hoshitoStats?.level ?? 1,
    hoshitoDomains:
      hoshitoStats?.domains && hoshitoStats.domains.length > 0
        ? hoshitoStats.domains
        : [blankDomain("Physical"), blankDomain("Mental"), blankDomain("Social")],
    hoshitoVerve: hoshitoStats?.verve ?? 1,
    hoshitoStoryPoints: hoshitoStats?.storyPoints ?? 0,
    hoshitoMerits: hoshitoStats?.merits ?? [],
    hoshitoCoreMerits: hoshitoStats?.coreMerits ?? [],
  };
}
function normalizeList(values: string[]) {
  return values.map((v) => v.trim()).filter(Boolean);
}
function normalizeExtraEntries(entries: Array<{ key: string; value: string }>) {
  const next: Record<string, string> = {};
  for (const e of entries) {
    const k = e.key.trim(), v = e.value.trim();
    if (!k || !v) continue;
    next[k] = v;
  }
  return next;
}
function normalizeDraft(draft: GameCardDraft): GameCharacterSheetGameCard | undefined {
  const extra = normalizeExtraEntries(draft.extraEntries);
  const abilities = normalizeList(draft.abilities);
  const strengths = normalizeList(draft.strengths);
  const weaknesses = normalizeList(draft.weaknesses);
  const shortDescription = draft.shortDescription.trim();
  const charClass = draft.class.trim();
  const attributes = draft.attributes
    .map((a) => ({ name: a.name.trim(), value: Number.isFinite(a.value) ? a.value : 0 }))
    .filter((a) => a.name);
  const rpgStats = draft.rpgStatsEnabled
    ? (() => {
        const pools = normalizeRpgStatPools({
          hp: { value: Math.max(0, draft.hpValue), max: Math.max(1, draft.hpMax) },
          pools: draft.pools,
        });
        return {
          attributes,
          hp: syncRpgHpFromPools(pools, { value: Math.max(0, draft.hpValue), max: Math.max(1, draft.hpMax) }),
          pools,
        };
      })()
    : undefined;
  const hasContent =
    !!shortDescription || !!charClass || abilities.length > 0 || strengths.length > 0 ||
    weaknesses.length > 0 || Object.keys(extra).length > 0 || !!rpgStats;
  if (!hasContent) return undefined;
  return { shortDescription, class: charClass, abilities, strengths, weaknesses, extra, ...(rpgStats ? { rpgStats } : {}) };
}
function hasGameData(gc?: GameCharacterSheetGameCard) {
  if (!gc) return false;
  return (
    !!gc.class || !!gc.shortDescription || gc.abilities.length > 0 ||
    gc.strengths.length > 0 || gc.weaknesses.length > 0 || Object.keys(gc.extra).length > 0
  );
}
function normalizeHoshitoDraft(
  draft: GameCardDraft,
  existing: HoshitoCharacterStats | null,
): HoshitoCharacterStats | undefined {
  if (!draft.hoshitoEnabled && !existing) return undefined;
  const domains = draft.hoshitoDomains
    .map((d) => ({
      name: d.name.trim() || "Domain",
      attributes: d.attributes
        .map((a) => ({ ...a, name: a.name.trim() }))
        .filter((a) => a.name),
    }))
    .filter((d) => d.attributes.length > 0);
  const merits = draft.hoshitoMerits
    .map((m) => ({
      ...m,
      name: m.name.trim(),
      description: m.description.trim(),
      // Abilities and Contacts grant no Spark per the ruleset — drop a stale value if the
      // category was changed after a Spark attribute was set.
      sparkGrantAttribute:
        m.category === "ability" || m.category === "contact"
          ? undefined
          : (m.sparkGrantAttribute?.trim() || undefined),
    }))
    .filter((m) => m.name || m.description);
  const coreMerits = draft.hoshitoCoreMerits
    .map((cm) => ({
      ...cm,
      description: cm.description.trim(),
      // attributeGrant and grantedSpark are mutually exclusive per the ruleset — drop a stale
      // attributeGrant if grantedSpark was toggled on after one was set.
      attributeGrant: cm.grantedSpark ? undefined : (cm.attributeGrant?.trim() || undefined),
      transformations: cm.transformations
        .map((t) => ({
          ...t,
          narrative: t.narrative.trim(),
          merit: { ...t.merit, name: t.merit.name.trim(), description: t.merit.description.trim() },
        }))
        .filter((t) => t.merit.name || t.merit.description),
    }))
    .filter((cm) => cm.description.length > 0);
  return {
    ...(existing ?? { level: 1, domains: [], verve: 1, storyPoints: 0 }),
    enabled: draft.hoshitoEnabled,
    level: Math.max(1, draft.hoshitoLevel),
    domains,
    verve: Math.max(0, draft.hoshitoVerve),
    storyPoints: Math.max(0, draft.hoshitoStoryPoints),
    merits,
    coreMerits,
  };
}

// ──────────────────────────────────────────────
// Upstream SectionHeader
// ──────────────────────────────────────────────

function SectionHeader({ icon, title, className }: { icon: React.ReactNode; title: string; className?: string }) {
  return (
    <div className={cn("mb-2.5 flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider", className)}>
      {icon}
      <span>{title}</span>
    </div>
  );
}

// ──────────────────────────────────────────────
// Hoshito CSS keyframes
// ──────────────────────────────────────────────

const HOSHITO_STYLES = `
@keyframes hoshito-sss-sparkle {
  0%   { background-position: 0%   50%; }
  50%  { background-position: 100% 50%; }
  100% { background-position: 0%   50%; }
}
@keyframes hoshito-ex-sweep {
  0%   { transform: translateX(-150%) skewX(-12deg); }
  100% { transform: translateX(250%)  skewX(-12deg); }
}
@keyframes hoshito-ex-pulse {
  0%, 100% { box-shadow: 0 0 4px 1px rgba(255,220,80,0.18); }
  50%       { box-shadow: 0 0 10px 3px rgba(255,220,80,0.42); }
}
`;

function useHoshitoStyles() {
  useEffect(() => {
    const id = "hoshito-grade-styles";
    if (document.getElementById(id)) return;
    const el = document.createElement("style");
    el.id = id;
    el.textContent = HOSHITO_STYLES;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);
}

// ──────────────────────────────────────────────
// Grade visual config
// ──────────────────────────────────────────────

type GradeTier = "deficit" | "baseline" | "trained" | "notable" | "peak" | "posthuman" | "sss" | "ex";

const GRADE_TIER: Record<HoshitoGrade, GradeTier> = {
  FFF: "deficit", "FF-": "deficit", FF: "deficit", "F-": "deficit",
  F: "baseline",
  E: "trained", D: "trained",
  C: "notable", B: "notable",
  A: "peak",
  S: "posthuman", SS: "posthuman",
  SSS: "sss",
  EX: "ex",
};

const TIER_STYLE: Record<GradeTier, { bg: string; color: string; border: string }> = {
  deficit:  { bg: "#2A0808", color: "#F87171", border: "#5C1A1A" },
  baseline: { bg: "#1F2937", color: "#6B7280", border: "#374151" },
  trained:  { bg: "#0F1F35", color: "#60A5FA", border: "#1E3A5F" },
  notable:  { bg: "#062B20", color: "#34D399", border: "#064E3B" },
  peak:     { bg: "#211500", color: "#FCD34D", border: "#78450A" },
  posthuman:{ bg: "#1E0B45", color: "#C4B5FD", border: "#2E1065" },
  sss:      { bg: "#211500", color: "#FFD700", border: "#78450A" },
  ex:       { bg: "#2D1A00", color: "#FFE566", border: "#8B6B10" },
};

function displayGrade(grade: HoshitoGrade): string {
  return grade.replace("-", "\u2212");
}

// ──────────────────────────────────────────────
// Resistance display helpers
// ──────────────────────────────────────────────

const DAMAGE_TYPE_COLOR: Record<HoshitoDamageType, string> = {
  Slash: "text-red-400", Pierce: "text-orange-400", Blunt: "text-amber-400",
  Spectral: "text-violet-400", Elemental: "text-blue-400", Empyreal: "text-teal-400",
};

const RESISTANCE_TIER_COLOR: Record<HoshitoResistanceTier, string> = {
  Fatal: "text-red-400", Weak: "text-orange-400", Normal: "text-neutral-500",
  Endured: "text-teal-400", Ineffective: "text-blue-400", Immune: "text-violet-500",
};

// ──────────────────────────────────────────────
// GradeBadge
// ──────────────────────────────────────────────

function GradeBadge({ grade, size = "md" }: { grade: HoshitoGrade; size?: "sm" | "md" | "lg" }) {
  const tier = GRADE_TIER[grade];
  const s = TIER_STYLE[tier];
  const isSSS = grade === "SSS";
  const isEX = grade === "EX";
  const padClass =
    size === "sm" ? "text-[0.6rem] px-1.5 py-0.5" :
    size === "lg" ? "text-sm px-3 py-1" :
    "text-xs px-2 py-0.5";

  return (
    <span
      className={cn(
        "relative inline-flex items-center justify-center overflow-hidden rounded font-mono font-bold tracking-tight select-none shrink-0",
        padClass,
        isEX && "[animation:hoshito-ex-pulse_2.5s_ease-in-out_infinite]",
      )}
      style={{
        background: isSSS
          ? "linear-gradient(135deg,#C8A94E 0%,#FFD700 25%,#FFF9C4 50%,#FFD700 75%,#C8A94E 100%)"
          : s.bg,
        backgroundSize: isSSS ? "300% 300%" : undefined,
        animation: isSSS
          ? "hoshito-sss-sparkle 3s ease-in-out infinite"
          : isEX ? "hoshito-ex-pulse 2.5s ease-in-out infinite" : undefined,
        color: isSSS ? "#1A1200" : s.color,
        border: `1px solid ${s.border}`,
      }}
    >
      {displayGrade(grade)}
      {isEX && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: "linear-gradient(90deg,transparent 0%,rgba(255,235,120,0.45) 50%,transparent 100%)",
            animation: "hoshito-ex-sweep 2.2s ease-in-out infinite",
          }}
        />
      )}
    </span>
  );
}

// ──────────────────────────────────────────────
// SparkPips
// ──────────────────────────────────────────────

function SparkPips({ standard, vestige, maxStandard = 3 }: { standard: number; vestige: number; maxStandard?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: maxStandard }, (_, i) => (
        <span key={`s${i}`} className={cn("text-xs leading-none", i < standard ? "text-amber-400" : "text-neutral-700")}>
          {i < standard ? "●" : "○"}
        </span>
      ))}
      {Array.from({ length: vestige }, (_, i) => (
        <span key={`v${i}`} className="text-xs leading-none text-violet-400" title="Vestige Spark — permanent">◆</span>
      ))}
    </span>
  );
}

// ──────────────────────────────────────────────
// Grade / Domain computation helpers
// ──────────────────────────────────────────────

function computeDomainGrade(attrs: HoshitoAttribute[]): HoshitoGrade {
  if (!attrs.length) return "F";
  const sum = attrs.reduce((acc, a) => acc + HOSHITO_GRADE_VALUES[a.grade], 0);
  const avg = Math.floor(sum / attrs.length);
  return HOSHITO_GRADE_ORDER.reduce((best, g) =>
    Math.abs(HOSHITO_GRADE_VALUES[g] - avg) < Math.abs(HOSHITO_GRADE_VALUES[best] - avg) ? g : best,
  );
}

function computeDomainSparks(attrs: HoshitoAttribute[]): number {
  return Math.floor(attrs.reduce((acc, a) => acc + a.sparks + a.vestigeSparks, 0) / 3);
}

function findAttrValue(stats: HoshitoCharacterStats, name: string): number {
  for (const domain of stats.domains) {
    const a = domain.attributes.find((x) => x.name.toUpperCase() === name.toUpperCase());
    if (a) return HOSHITO_GRADE_VALUES[a.grade];
  }
  return HOSHITO_GRADE_VALUES["F"];
}

function computeDerived(s: HoshitoCharacterStats) {
  const cfg = s.derivedStatConfig ?? DEFAULT_DERIVED_STAT_CONFIG;
  const mig = findAttrValue(s, cfg.healthAttr1);
  const wil = findAttrValue(s, cfg.healthAttr2);
  const vit = findAttrValue(s, cfg.staggerAttr1);
  const int = findAttrValue(s, cfg.staggerAttr2);
  const psy = findAttrValue(s, cfg.apAttr);
  return {
    healthMax:  s.healthMax  ?? 25 + (mig + wil) * 5,
    staggerMax: s.staggerMax ?? 15 + (vit + int) * 5,
    apMax:      s.apMax      ?? 3 + Math.floor(psy / 3),
    verveMax:   s.level <= 1 ? 1 : Math.floor(s.level / 2),
  };
}

// ──────────────────────────────────────────────
// Domain accent palette
// ──────────────────────────────────────────────

const DOMAIN_ACCENT = [
  { headerClass: "text-red-400",    borderClass: "border-l-red-800/70" },
  { headerClass: "text-blue-400",   borderClass: "border-l-blue-800/70" },
  { headerClass: "text-violet-400", borderClass: "border-l-violet-800/70" },
] as const;

// ──────────────────────────────────────────────
// AttributeRow
// ──────────────────────────────────────────────

function AttributeRow({
  attr,
  primaryAttrName,
  onExalt,
}: {
  attr: HoshitoAttribute;
  primaryAttrName?: string;
  onExalt?: () => void;
}) {
  const isPrimary = !!primaryAttrName && attr.name.toUpperCase() === primaryAttrName.toUpperCase();
  const maxSparks = isPrimary ? 4 : 3;
  const isDeficit = (["FFF", "FF-", "FF", "F-"] as HoshitoGrade[]).includes(attr.grade);

  return (
    <div className="flex items-center gap-2 px-3 py-1 rounded hover:bg-white/[0.04] transition-colors">
      <span
        className={cn(
          "min-w-8 max-w-[6.5rem] shrink-0 truncate text-[0.7rem] font-mono font-bold tracking-wide",
          isDeficit ? "text-red-400/60" : "text-neutral-400",
        )}
        title={attr.name}
      >
        {attr.name}
      </span>
      {attr.isExalted && (
        <span className="text-amber-500 text-[0.65rem]" title={`Exalted ×${attr.exaltCount ?? 1}`}>
          {"★".repeat(attr.exaltCount ?? 1)}
        </span>
      )}
      <GradeBadge grade={attr.grade} size="sm" />
      <SparkPips standard={attr.sparks} vestige={attr.vestigeSparks} maxStandard={maxSparks} />
      {isPrimary && (
        <span className="ml-auto text-[0.55rem] font-semibold uppercase tracking-widest text-amber-500/60">Primary</span>
      )}
      {onExalt && !isPrimary && (
        <button
          type="button"
          onClick={onExalt}
          title={attr.isExalted ? `Exalted ×${attr.exaltCount ?? 1} — click to remove` : "Exalt this attribute"}
          className={cn(
            "ml-auto rounded px-1 py-0.5 text-[0.6rem] transition-colors",
            attr.isExalted
              ? "text-amber-500 hover:text-amber-300"
              : "text-neutral-700 hover:text-amber-500",
          )}
        >
          {attr.isExalted ? "★" : "☆"}
        </button>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// DomainCard
// ──────────────────────────────────────────────

function DomainCard({
  domain,
  index,
  level,
  primaryAttrName,
  onExaltAttr,
}: {
  domain: HoshitoCharacterStats["domains"][0];
  index: number;
  level: number;
  primaryAttrName?: string;
  onExaltAttr?: (attrIdx: number) => void;
}) {
  const accent = DOMAIN_ACCENT[index % 3] ?? DOMAIN_ACCENT[0];
  const domGrade  = computeDomainGrade(domain.attributes);
  const domSparks = computeDomainSparks(domain.attributes);
  const saveBonus = level + HOSHITO_GRADE_VALUES[domGrade] + domSparks;
  const hasExalted = domain.attributes.some((a) => a.isExalted);

  return (
    <div className={cn("rounded-lg border border-white/[0.07] bg-white/[0.02] border-l-2", accent.borderClass)}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.05]">
        <span className={cn("flex-1 text-[0.7rem] font-bold uppercase tracking-widest", accent.headerClass)}>
          {domain.name}
          {hasExalted && <span className="ml-1 text-amber-500">+</span>}
        </span>
        <GradeBadge grade={domGrade} size="sm" />
        <SparkPips standard={domSparks} vestige={0} maxStandard={3} />
        <span className="ml-1 text-[0.6rem] text-neutral-600">
          Save {saveBonus >= 0 ? `+${saveBonus}` : saveBonus}
        </span>
      </div>
      <div className="py-1">
        {domain.attributes.map((attr, ai) => (
          <AttributeRow
            key={attr.name}
            attr={attr}
            primaryAttrName={primaryAttrName}
            onExalt={onExaltAttr ? () => onExaltAttr(ai) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// DerivedStatsPanel
// ──────────────────────────────────────────────

function DerivedStatsPanel({ s }: { s: HoshitoCharacterStats }) {
  const { healthMax, staggerMax, apMax, verveMax } = computeDerived(s);
  const cells: Array<{ label: string; value: string; colorClass: string }> = [
    { label: "Health",    value: s.health  != null ? `${s.health}/${healthMax}`   : String(healthMax),  colorClass: "text-red-400"    },
    { label: "Stagger",   value: s.stagger != null ? `${s.stagger}/${staggerMax}` : String(staggerMax), colorClass: "text-blue-400"   },
    { label: "AP",        value: String(apMax),                                                          colorClass: "text-yellow-400" },
    { label: "Coins",     value: String(s.coins ?? 3),                                                   colorClass: "text-amber-500"  },
    { label: "Verve",     value: `${s.verve}/${verveMax}`,                                               colorClass: "text-violet-400" },
    { label: "Story Pts", value: String(s.storyPoints),                                                  colorClass: "text-teal-400"   },
  ];

  return (
    <div className="grid grid-cols-3 gap-1.5">
      {cells.map((c) => (
        <div key={c.label} className="flex flex-col items-center rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-2">
          <span className="text-[0.575rem] font-semibold uppercase tracking-wider text-neutral-500">{c.label}</span>
          <span className={cn("text-base font-bold font-mono leading-tight mt-0.5", c.colorClass)}>{c.value}</span>
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────
// Default Action Cards
// ──────────────────────────────────────────────

type SlotKey = "melee" | "ranged" | "defensive";
const SLOT_KEYS: SlotKey[] = ["melee", "ranged", "defensive"];

const SLOT_META: Record<SlotKey, {
  label: string; icon: React.ReactNode; headerClass: string; borderClass: string;
  options: Array<{ value: HoshitoDefaultActionType; label: string }>;
}> = {
  melee: {
    label: "Melee Offensive", icon: <Swords size={11} />,
    headerClass: "text-orange-400", borderClass: "border-orange-900/50",
    options: [
      { value: "HMW",          label: "Heavy Melee Weapon" },
      { value: "LMW",          label: "Light Melee Weapon" },
      { value: "MeleeCantrip", label: "Melee Cantrip"      },
      { value: "Unarmed",      label: "Unarmed Attack"     },
    ],
  },
  ranged: {
    label: "Ranged Offensive", icon: <Target size={11} />,
    headerClass: "text-sky-400", borderClass: "border-sky-900/50",
    options: [
      { value: "Marksmanship", label: "Marksmanship"    },
      { value: "SpellCantrip", label: "Spell / Cantrip" },
    ],
  },
  defensive: {
    label: "Defensive", icon: <Shield size={11} />,
    headerClass: "text-teal-400", borderClass: "border-teal-900/50",
    options: [
      { value: "Evade",      label: "Evade"       },
      { value: "Guard",      label: "Guard"       },
      { value: "PowerGuard", label: "Power Guard" },
    ],
  },
};

function DefaultActionCard({
  slotKey, action, nameLibrary, isEditing, onStartEdit, onSave,
}: {
  slotKey: SlotKey;
  action: HoshitoDefaultActions[SlotKey];
  nameLibrary: string[];
  isEditing: boolean;
  onStartEdit: () => void;
  onSave: (updated: HoshitoDefaultActions[SlotKey]) => void;
}) {
  const meta = SLOT_META[slotKey];
  const [draftName, setDraftName] = useState(action.name);
  const [draftType, setDraftType] = useState(action.type);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setDraftName(action.name);
      setDraftType(action.type);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isEditing, action.name, action.type]);

  const typeLabel = meta.options.find((o) => o.value === draftType)?.label ?? draftType;

  return (
    <div className={cn("flex flex-col rounded-lg border bg-white/[0.02] overflow-hidden", meta.borderClass)}>
      <div className={cn("flex items-center gap-1.5 border-b border-white/[0.05] px-3 py-1.5", meta.headerClass)}>
        {meta.icon}
        <span className="flex-1 text-[0.575rem] font-bold uppercase tracking-widest">{meta.label}</span>
        {!isEditing && (
          <button onClick={onStartEdit} className="text-neutral-600 hover:text-neutral-300 transition-colors" title="Edit action">
            <Pencil size={10} />
          </button>
        )}
      </div>
      {isEditing ? (
        <div className="flex flex-col gap-2 p-3">
          <input
            ref={inputRef}
            type="text"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Name this action…"
            maxLength={40}
            className="w-full rounded border border-white/10 bg-white/[0.06] px-2 py-1.5 text-center text-sm font-bold text-white/90 outline-none focus:border-white/25 placeholder:text-neutral-600 transition-colors"
          />
          <select
            value={draftType}
            onChange={(e) => setDraftType(e.target.value as HoshitoDefaultActionType)}
            className="w-full rounded border border-white/10 bg-[#0e0e10] px-2 py-1.5 text-xs text-neutral-300 outline-none appearance-none cursor-pointer"
          >
            {meta.options.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {nameLibrary.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {nameLibrary.map((tag) => (
                <button
                  key={tag} type="button" onClick={() => setDraftName(tag)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[0.575rem] transition-colors",
                    draftName === tag
                      ? "border-white/25 bg-white/10 text-white"
                      : "border-white/[0.08] bg-white/[0.04] text-neutral-500 hover:text-white hover:border-white/20",
                  )}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
          <div className="mt-1 flex gap-1.5">
            <button
              type="button"
              onClick={() => onSave({ name: draftName.trim() || action.name, type: draftType })}
              className="flex-1 rounded bg-white/10 py-1 text-xs font-semibold text-white hover:bg-white/15 transition-colors"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => { setDraftName(action.name); setDraftType(action.type); }}
              className="flex-1 rounded bg-white/[0.04] py-1 text-xs text-neutral-500 hover:bg-white/[0.08] transition-colors"
            >
              Reset
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-1 px-3 py-4 text-center flex-1">
          <span className="text-base font-bold leading-tight text-white/90">{action.name || "—"}</span>
          <span className="mt-1 text-[0.625rem] text-neutral-500">{typeLabel}</span>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// Merits section
// ──────────────────────────────────────────────

const MERIT_CATEGORY_LABELS: Record<string, string> = {
  feat: "Feats", artifact: "Artifacts", ability: "Abilities", augment: "Augments", contact: "Contacts",
};
const MERIT_CATEGORY_ORDER = ["feat", "artifact", "ability", "augment", "contact"] as const;
const CORE_MERIT_TYPE_LABELS: Record<HoshitoCoreMerit["type"], string> = {
  ancestry: "Ancestry", heritage: "Heritage", background: "Background",
};
const CORE_MERIT_TYPE_ORDER: HoshitoCoreMerit["type"][] = ["ancestry", "heritage", "background"];

function MeritsSection({ s }: { s: HoshitoCharacterStats }) {
  const grouped = MERIT_CATEGORY_ORDER.reduce<Record<string, typeof s.merits>>((acc, cat) => {
    const entries = (s.merits ?? []).filter((m) => m.category === cat);
    if (entries.length) acc[cat] = entries;
    return acc;
  }, {});

  if (!s.merits?.length && !s.coreMerits?.length) {
    return <p className="text-xs text-neutral-600 px-1 py-4 text-center">No merits recorded yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {!!s.coreMerits?.length && (
        <div>
          <p className="mb-2 text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-500">Core Merits</p>
          <div className="flex flex-col gap-1.5">
            {s.coreMerits.map((cm, i) => (
              <div key={i} className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-[0.625rem] font-bold uppercase tracking-wider text-amber-500/70">{cm.type}</span>
                  {cm.transformations.length > 0 && (
                    <span className="text-[0.575rem] text-violet-400">
                      ×{cm.transformations.length} transformation{cm.transformations.length > 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-neutral-400 leading-relaxed">{cm.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {MERIT_CATEGORY_ORDER.filter((cat) => grouped[cat]).map((cat) => (
        <div key={cat}>
          <p className="mb-2 text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-500">
            {MERIT_CATEGORY_LABELS[cat]}
          </p>
          <div className="flex flex-col gap-1.5">
            {(grouped[cat] ?? []).map((merit, i) => (
              <div key={i} className={cn("rounded-lg border bg-white/[0.02] px-3 py-2", merit.dormant ? "border-white/[0.04] opacity-50" : "border-white/[0.07]")}>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-white/80">{merit.name}</span>
                  {merit.dormant && <span className="text-[0.55rem] text-neutral-600 uppercase tracking-wider">dormant</span>}
                  {merit.sparkGrantAttribute && (
                    <span className="ml-auto text-[0.575rem] text-amber-400">+1 Spark ({merit.sparkGrantAttribute})</span>
                  )}
                </div>
                {merit.description && (
                  <p className="mt-0.5 text-xs text-neutral-500 leading-relaxed">{merit.description}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────
// Strand section
// ──────────────────────────────────────────────

function StrandSection({ s }: { s: HoshitoCharacterStats }) {
  if (!s.strand) {
    return (
      <p className="text-xs text-neutral-600 px-1 py-4 text-center">
        No Strand declared yet. Must be committed before end of Level 3.
      </p>
    );
  }
  const st = s.strand;
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-3">
        <div className="flex items-start gap-2">
          <Star size={12} className="mt-0.5 shrink-0 text-amber-500" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-amber-400">{st.name}</p>
            <p className="mt-0.5 text-xs text-neutral-400 leading-relaxed">{st.description}</p>
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-2 text-[0.6rem]">
          <span className="text-neutral-500">
            Primary: <span className="font-bold text-amber-500/80">{st.primaryAttribute}</span>
          </span>
          {st.fork && (
            <span className="text-neutral-500">
              Fork: <span className="font-bold text-white/60 capitalize">{st.fork.replace("_", " ")}</span>
            </span>
          )}
        </div>
      </div>
      {st.abilityMerits.length > 0 && (
        <div>
          <p className="mb-1.5 text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-500">Strand Abilities</p>
          <div className="flex flex-col gap-1">
            {st.abilityMerits.map((ab, i) => (
              <div key={i} className="rounded border border-white/[0.06] bg-white/[0.02] px-3 py-1.5">
                <span className="text-xs text-white/75">{ab}</span>
              </div>
            ))}
          </div>
          {st.culminationMerit && (
            <div className="mt-1 rounded border border-amber-900/50 bg-amber-950/30 px-3 py-1.5">
              <span className="text-[0.575rem] font-semibold uppercase tracking-wider text-amber-600">Culmination</span>
              <p className="mt-0.5 text-xs text-amber-400/80">{st.culminationMerit}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// Alignment badge
// ──────────────────────────────────────────────

const ALIGNMENT_STYLE: Record<string, { label: string; colorClass: string; icon: React.ReactNode }> = {
  spectral:  { label: "Spectral",  colorClass: "text-violet-400 border-violet-900/60 bg-violet-950/30",  icon: <Sparkles size={10} /> },
  elemental: { label: "Elemental", colorClass: "text-orange-400 border-orange-900/60 bg-orange-950/30", icon: <Wand2 size={10} /> },
  empyreal:  { label: "Empyreal",  colorClass: "text-sky-400    border-sky-900/60    bg-sky-950/30",     icon: <Star size={10} /> },
};

// ──────────────────────────────────────────────
// Legacy RPG Attributes view
// ──────────────────────────────────────────────

function RpgAttributesView({ rpgStats }: { rpgStats: NonNullable<GameCharacterSheetGameCard["rpgStats"]> }) {
  const hasAttrs = Array.isArray(rpgStats.attributes) && rpgStats.attributes.length > 0;
  const hpMax   = Math.max(1, Number(rpgStats.hp?.max)   || 1);
  const hpValue = Math.max(0, Math.min(hpMax, Number(rpgStats.hp?.value) || 0));

  return (
    <div>
      <p className="mb-2 text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-600">RPG Attributes</p>
      {hasAttrs && (
        <div className="mb-3 grid grid-cols-3 gap-2">
          {rpgStats.attributes.map((attr) => (
            <div key={attr.name} className="flex flex-col items-center rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5">
              <span className="text-[0.5625rem] font-bold uppercase tracking-widest text-neutral-500">{attr.name}</span>
              <span className="text-lg font-bold leading-tight text-white/90">{attr.value}</span>
              <span className="text-[0.625rem] font-mono leading-none text-neutral-600">{formatAttributeModifier(attr.value)}</span>
            </div>
          ))}
        </div>
      )}
      <div>
        <div className="mb-0.5 flex items-center justify-between text-xs">
          <span className="font-medium text-white/80">HP</span>
          <span className="font-mono text-neutral-500">{hpValue}/{hpMax}</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.04] ring-1 ring-white/[0.07]">
          <div className="h-full rounded-full transition-all" style={{ width: `${(hpValue / hpMax) * 100}%`, background: "#ef4444" }} />
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Tab definitions
// ──────────────────────────────────────────────

type Tab = "sheet" | "actions" | "merits";
const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: "sheet",   label: "Sheet",   icon: <Target size={12} />   },
  { id: "actions", label: "Actions", icon: <Swords size={12} />   },
  { id: "merits",  label: "Merits",  icon: <BookOpen size={12} /> },
];

// ──────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────

export function GameCharacterSheet({
  card,
  onClose,
  onSave,
  onRegenerate,
  isRegenerating = false,
}: GameCharacterSheetProps) {
  useHoshitoStyles();

  const hs = card.hoshitoStats ?? null;

  // ── Upstream draft/edit state ──
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving,  setIsSaving]  = useState(false);
  const [draft, setDraft] = useState<GameCardDraft>(() => createDraft(card.gameCard, hs));

  // ── Hoshito-specific state ──
  const [activeTab,    setActiveTab]    = useState<Tab>("sheet");
  const [editingSlot,  setEditingSlot]  = useState<SlotKey | null>(null);
  const [defaultActions, setDefaultActions] = useState<HoshitoDefaultActions>(() => hs?.defaultActions ?? HOSHITO_DEFAULT_ACTIONS);
  const [nameLibrary,    setNameLibrary]    = useState<string[]>(() => hs?.actionNameLibrary ?? []);

  // ── Add Merit popup — captured here, only pushed into draft.hoshitoMerits on confirm ──
  const [showAddMeritPopup, setShowAddMeritPopup] = useState(false);
  const [newMeritDraft, setNewMeritDraft] = useState<{
    category: HoshitoMerit["category"];
    name: string;
    description: string;
    sparkGrantAttribute: string;
    dormant: boolean;
  }>({ category: "feat", name: "", description: "", sparkGrantAttribute: "", dormant: false });

  // ── Add Core Merit popup — captured here, only pushed into draft.hoshitoCoreMerits on confirm ──
  const [showAddCoreMeritPopup, setShowAddCoreMeritPopup] = useState(false);
  const [newCoreMeritDraft, setNewCoreMeritDraft] = useState<{
    type: HoshitoCoreMerit["type"];
    description: string;
    attributeGrant: string;
    grantedSpark: boolean;
  }>({ type: "ancestry", description: "", attributeGrant: "", grantedSpark: false });

  // Sync when card changes
  useEffect(() => {
    setIsEditing(false);
    setIsSaving(false);
    const h = card.hoshitoStats ?? null;
    setDraft(createDraft(card.gameCard, h));
    setActiveTab("sheet");
    setEditingSlot(null);
    setDefaultActions(h?.defaultActions ?? HOSHITO_DEFAULT_ACTIONS);
    setNameLibrary(h?.actionNameLibrary ?? []);
  }, [card]);

  // ── Upstream preview helpers ──
  const previewGameCard = isEditing ? normalizeDraft(draft) : normalizeDraft(createDraft(card.gameCard));
  const hasRpgAttributes =
    previewGameCard?.rpgStats &&
    Array.isArray(previewGameCard.rpgStats.attributes) &&
    previewGameCard.rpgStats.attributes.length > 0;
  const previewRpgPools = previewGameCard?.rpgStats ? normalizeRpgStatPools(previewGameCard.rpgStats) : [];
  const hasRpgPools = previewRpgPools.length > 0;
  const hasRpgStats = Boolean(hasRpgAttributes || hasRpgPools);
  const hasPersistentSheetData = hasGameData(previewGameCard) || hasRpgStats;
  const hasAnyData = hasPersistentSheetData || (card.stats?.length ?? 0) > 0 || (card.inventory?.length ?? 0) > 0 || Object.keys(card.customFields ?? {}).length > 0;

  // ── Upstream list handlers ──
  const updateListItem = (field: DraftListField, idx: number, value: string) =>
    setDraft((p) => ({ ...p, [field]: p[field].map((item, i) => (i === idx ? value : item)) }));
  const addListItem = (field: DraftListField) =>
    setDraft((p) => ({ ...p, [field]: [...p[field], ""] }));
  const removeListItem = (field: DraftListField, idx: number) =>
    setDraft((p) => {
      const next = p[field].filter((_, i) => i !== idx);
      return { ...p, [field]: next.length > 0 ? next : [""] };
    });
  const updateExtraEntry = (idx: number, field: "key" | "value", value: string) =>
    setDraft((p) => ({ ...p, extraEntries: p.extraEntries.map((e, i) => (i === idx ? { ...e, [field]: value } : e)) }));
  const addExtraEntry = () =>
    setDraft((p) => ({ ...p, extraEntries: [...p.extraEntries, { key: "", value: "" }] }));
  const removeExtraEntry = (idx: number) =>
    setDraft((p) => {
      const next = p.extraEntries.filter((_, i) => i !== idx);
      return { ...p, extraEntries: next.length > 0 ? next : [{ key: "", value: "" }] };
    });
  const updateAttribute = (idx: number, field: "name" | "value", value: string | number) =>
    setDraft((p) => ({
      ...p,
      attributes: p.attributes.map((a, i) =>
        i === idx ? { ...a, [field]: field === "value" ? Number(value) || 0 : String(value) } : a,
      ),
    }));
  const addAttribute = () =>
    setDraft((p) => ({ ...p, attributes: [...p.attributes, { name: "NEW", value: 10 }] }));
  const removeAttribute = (idx: number) =>
    setDraft((p) => {
      const next = p.attributes.filter((_, i) => i !== idx);
      return { ...p, attributes: next.length > 0 ? next : DEFAULT_ATTRIBUTES.map((a) => ({ ...a })) };
    });

  // ── Hoshito domain/attribute editing (only mutates draft — committed on Save, reverted on Cancel) ──
  const updateHoshitoDomainName = (domainIdx: number, name: string) => {
    setDraft((p) => ({
      ...p,
      hoshitoDomains: p.hoshitoDomains.map((d, di) => (di === domainIdx ? { ...d, name } : d)),
    }));
  };
  const addHoshitoDomain = () => {
    setDraft((p) => ({
      ...p,
      hoshitoDomains: [
        ...p.hoshitoDomains,
        { name: `Domain ${p.hoshitoDomains.length + 1}`, attributes: [{ name: "NEW", grade: "F" as HoshitoGrade, sparks: 0, vestigeSparks: 0 }] },
      ],
    }));
  };
  const removeHoshitoDomain = (domainIdx: number) => {
    setDraft((p) => ({ ...p, hoshitoDomains: p.hoshitoDomains.filter((_, di) => di !== domainIdx) }));
  };
  const updateHoshitoAttr = (
    domainIdx: number,
    attrIdx: number,
    field: "name" | "grade" | "sparks" | "vestigeSparks" | "isExalted",
    value: string | number | boolean,
  ) => {
    setDraft((p) => ({
      ...p,
      hoshitoDomains: p.hoshitoDomains.map((d, di) =>
        di !== domainIdx ? d : {
          ...d,
          attributes: d.attributes.map((a, ai) => (ai !== attrIdx ? a : { ...a, [field]: value })),
        },
      ),
    }));
  };
  const addHoshitoAttr = (domainIdx: number) => {
    setDraft((p) => ({
      ...p,
      hoshitoDomains: p.hoshitoDomains.map((d, di) =>
        di === domainIdx ? { ...d, attributes: [...d.attributes, { name: "NEW", grade: "F" as HoshitoGrade, sparks: 0, vestigeSparks: 0 }] } : d,
      ),
    }));
  };
  const removeHoshitoAttr = (domainIdx: number, attrIdx: number) => {
    setDraft((p) => ({
      ...p,
      hoshitoDomains: p.hoshitoDomains.map((d, di) =>
        di === domainIdx ? { ...d, attributes: d.attributes.filter((_, ai) => ai !== attrIdx) } : d,
      ),
    }));
  };

  // ── Hoshito merit editing (same draft-only / Save-commits / Cancel-reverts lifecycle) ──
  const openAddMeritPopup = () => {
    setNewMeritDraft({ category: "feat", name: "", description: "", sparkGrantAttribute: "", dormant: false });
    setShowAddMeritPopup(true);
  };
  const cancelAddMeritPopup = () => setShowAddMeritPopup(false);
  const confirmAddMerit = () => {
    const name = newMeritDraft.name.trim();
    const description = newMeritDraft.description.trim();
    if (!name && !description) return;
    const canGrantSpark = newMeritDraft.category !== "ability" && newMeritDraft.category !== "contact";
    setDraft((p) => ({
      ...p,
      hoshitoMerits: [
        ...p.hoshitoMerits,
        {
          category: newMeritDraft.category,
          name,
          description,
          sparkGrantAttribute: canGrantSpark ? (newMeritDraft.sparkGrantAttribute.trim() || undefined) : undefined,
          dormant: newMeritDraft.dormant,
        },
      ],
    }));
    setShowAddMeritPopup(false);
  };
  const updateHoshitoMerit = (
    idx: number,
    field: "category" | "name" | "description" | "sparkGrantAttribute" | "dormant",
    value: string | boolean,
  ) => {
    setDraft((p) => ({
      ...p,
      hoshitoMerits: p.hoshitoMerits.map((m, i) => (i !== idx ? m : { ...m, [field]: value })),
    }));
  };
  const removeHoshitoMerit = (idx: number) => {
    setDraft((p) => ({ ...p, hoshitoMerits: p.hoshitoMerits.filter((_, i) => i !== idx) }));
  };

  // ── Core Merit editing (same draft-only / Save-commits / Cancel-reverts lifecycle) ──
  const openAddCoreMeritPopup = () => {
    const used = new Set(draft.hoshitoCoreMerits.map((cm) => cm.type));
    const nextType = CORE_MERIT_TYPE_ORDER.find((t) => !used.has(t)) ?? "ancestry";
    setNewCoreMeritDraft({ type: nextType, description: "", attributeGrant: "", grantedSpark: false });
    setShowAddCoreMeritPopup(true);
  };
  const cancelAddCoreMeritPopup = () => setShowAddCoreMeritPopup(false);
  const confirmAddCoreMerit = () => {
    const description = newCoreMeritDraft.description.trim();
    if (!description) return;
    setDraft((p) => ({
      ...p,
      hoshitoCoreMerits: [
        ...p.hoshitoCoreMerits,
        {
          type: newCoreMeritDraft.type,
          description,
          attributeGrant: newCoreMeritDraft.grantedSpark ? undefined : (newCoreMeritDraft.attributeGrant.trim() || undefined),
          grantedSpark: newCoreMeritDraft.grantedSpark,
          transformations: [],
        },
      ],
    }));
    setShowAddCoreMeritPopup(false);
  };
  const updateCoreMerit = (
    idx: number,
    field: "type" | "description" | "attributeGrant" | "grantedSpark",
    value: string | boolean,
  ) => {
    setDraft((p) => ({
      ...p,
      hoshitoCoreMerits: p.hoshitoCoreMerits.map((cm, i) => (i !== idx ? cm : { ...cm, [field]: value })),
    }));
  };
  const removeCoreMerit = (idx: number) => {
    setDraft((p) => ({ ...p, hoshitoCoreMerits: p.hoshitoCoreMerits.filter((_, i) => i !== idx) }));
  };

  // ── Core Merit transformations — earned at Level 7/14/21/26 (or a pivotal moment), nested per Core Merit ──
  const addTransformation = (coreMeritIdx: number) => {
    setDraft((p) => ({
      ...p,
      hoshitoCoreMerits: p.hoshitoCoreMerits.map((cm, i) =>
        i !== coreMeritIdx
          ? cm
          : {
              ...cm,
              transformations: [
                ...cm.transformations,
                { merit: { category: "feat" as HoshitoMerit["category"], name: "", description: "" }, level: 7, narrative: "" },
              ],
            },
      ),
    }));
  };
  const updateTransformation = (
    coreMeritIdx: number,
    transformIdx: number,
    field: "level" | "narrative" | "meritCategory" | "meritName" | "meritDescription",
    value: string | number,
  ) => {
    setDraft((p) => ({
      ...p,
      hoshitoCoreMerits: p.hoshitoCoreMerits.map((cm, i) =>
        i !== coreMeritIdx
          ? cm
          : {
              ...cm,
              transformations: cm.transformations.map((t, ti) => {
                if (ti !== transformIdx) return t;
                if (field === "level") return { ...t, level: Number(value) || 7 };
                if (field === "narrative") return { ...t, narrative: String(value) };
                if (field === "meritCategory") return { ...t, merit: { ...t.merit, category: value as HoshitoMerit["category"] } };
                if (field === "meritName") return { ...t, merit: { ...t.merit, name: String(value) } };
                return { ...t, merit: { ...t.merit, description: String(value) } };
              }),
            },
      ),
    }));
  };
  const removeTransformation = (coreMeritIdx: number, transformIdx: number) => {
    setDraft((p) => ({
      ...p,
      hoshitoCoreMerits: p.hoshitoCoreMerits.map((cm, i) =>
        i !== coreMeritIdx ? cm : { ...cm, transformations: cm.transformations.filter((_, ti) => ti !== transformIdx) },
      ),
    }));
  };

  const updatePool = (index: number, patch: Partial<RPGStatPool>) => {
    setDraft((prev) => {
      const pools = prev.pools.map((pool, poolIndex) => (poolIndex === index ? { ...pool, ...patch } : pool));
      const hp = syncRpgHpFromPools(pools, { value: prev.hpValue, max: prev.hpMax });
      return { ...prev, pools, hpValue: hp.value, hpMax: hp.max };
    });
  };

  const addPool = () => {
    setDraft((prev) => ({ ...prev, pools: [...prev.pools, createNewRpgPool(prev.pools)] }));
  };

  const removePool = (index: number) => {
    setDraft((prev) => {
      const pools = prev.pools.filter((_, poolIndex) => poolIndex !== index);
      const nextPools = pools.length > 0 ? pools : createDefaultRpgStatPools();
      const hp = syncRpgHpFromPools(nextPools, { value: prev.hpValue, max: prev.hpMax });
      return { ...prev, pools: nextPools, hpValue: hp.value, hpMax: hp.max };
    });
  };

  const handleCancelEdit = () => {
    setDraft(createDraft(card.gameCard, hs));
    setIsEditing(false);
  };

  // ── Action handlers ──
  const handleSaveAction = (slotKey: SlotKey, updated: HoshitoDefaultActions[SlotKey]) => {
    const next = { ...defaultActions, [slotKey]: updated };
    setDefaultActions(next);
    if (updated.name && !nameLibrary.includes(updated.name)) {
      setNameLibrary((prev) => [updated.name, ...prev].slice(0, 24));
    }
    setEditingSlot(null);
  };

  // ── Save ──
  const handleSave = async () => {
    if (!onSave || isSaving) return;
    setIsSaving(true);
    try {
      const gameCardToSave = isEditing ? normalizeDraft(draft) : card.gameCard;
      const hoshitoBase = isEditing ? normalizeHoshitoDraft(draft, hs) : hs ?? undefined;
      const hoshitoToSave = hoshitoBase
        ? { ...hoshitoBase, defaultActions, actionNameLibrary: nameLibrary }
        : undefined;
      await onSave(gameCardToSave, hoshitoToSave);
      onClose();
    } catch {
      /* ignore */
    } finally {
      setIsSaving(false);
      setIsEditing(false);
    }
  };

  const handleRegenerate = async () => {
    if (!onRegenerate || isSaving || isRegenerating) return;
    await onRegenerate();
  };

  const hoshitoActive = !!hs && hs.enabled !== false;
  const level = hoshitoActive ? (hs?.level ?? card.level ?? 1) : (card.level ?? 1);
  const alignment = hoshitoActive ? hs?.magicAlignment : undefined;
  const alignStyle = alignment ? ALIGNMENT_STYLE[alignment] : null;

  return (
    <>
    <div
      data-game-skip-bg-nav="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-[max(env(safe-area-inset-top),0.75rem)] backdrop-blur-sm sm:p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          NEUTRAL_SURFACE_VARIABLES,
          "marinara-chat-popover relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-panel-bg)] shadow-2xl supports-[height:100dvh]:max-h-[88dvh]",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Toolbar (Edit Sheet / Save Sheet / Cancel / Regenerate) ── */}
        {(onSave || onRegenerate) && (
          <div className="absolute right-11 top-3 z-10 flex max-w-[calc(100%-4rem)] flex-wrap items-center justify-end gap-1 sm:right-12 sm:gap-2">
            {isEditing ? (
              <>
                <button
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                  className="inline-flex h-8 items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-button-bg)] px-2.5 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)] disabled:opacity-60 sm:h-auto sm:px-3 sm:py-1.5"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleSave()}
                  disabled={isSaving}
                  className="inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg bg-[var(--marinara-chat-chrome-highlight-bg)] px-2 text-xs font-semibold text-[var(--foreground)] ring-1 ring-[var(--marinara-chat-chrome-panel-border)] transition-colors hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] disabled:opacity-60 sm:h-auto sm:min-w-0 sm:px-3 sm:py-1.5"
                  title={isSaving ? "Saving..." : "Save Sheet"}
                >
                  <Save size={13} />
                  <span className="hidden sm:inline">{isSaving ? "Saving..." : "Save Sheet"}</span>
                </button>
              </>
            ) : (
              <>
                {onRegenerate && (
                  <button
                    onClick={() => void handleRegenerate()}
                    disabled={isRegenerating || isSaving}
                    className="inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-button-bg)] px-2 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)] disabled:cursor-wait disabled:opacity-60 sm:h-auto sm:min-w-0 sm:px-3 sm:py-1.5"
                    title="Regenerate this sheet from character and current game context"
                  >
                    <RefreshCw size={13} className={cn(isRegenerating && "animate-spin")} />
                    <span className="hidden sm:inline">{isRegenerating ? "Regenerating..." : "Regenerate Sheet"}</span>
                  </button>
                )}
                {onSave && (
                  <button
                    onClick={() => setIsEditing(true)}
                    disabled={isRegenerating}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-button-bg)] p-0 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)] disabled:opacity-60 sm:h-auto sm:w-auto sm:min-w-0 sm:gap-1.5 sm:px-3 sm:py-1.5"
                    title="Edit Sheet"
                  >
                    <Pencil size={13} />
                    <span className="hidden sm:inline">Edit Sheet</span>
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Close button ── */}
        <button
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-lg p-0 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)] sm:h-auto sm:w-auto sm:p-1.5"
          aria-label="Close character sheet"
        >
          <X className="h-4 w-4 sm:h-[18px] sm:w-[18px]" />
        </button>

        {/* ── Header ── */}
        <div className="relative border-b border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-highlight-bg)] px-4 py-4 sm:px-5">
          <div className="flex items-center gap-3 sm:gap-4">
            {card.avatarUrl ? (
              <span className="relative block h-16 w-16 shrink-0 overflow-hidden rounded-xl border-2 border-[var(--marinara-chat-chrome-panel-border)] shadow-xl sm:h-20 sm:w-20">
                <img
                  src={card.avatarUrl}
                  alt={card.title}
                  className="h-full w-full object-cover"
                  style={getAvatarCropStyle(card.avatarCrop)}
                />
              </span>
            ) : (
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border-2 border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-highlight-bg)] text-xl font-bold text-[var(--muted-foreground)] sm:h-20 sm:w-20 sm:text-2xl">
                {card.title[0]}
              </div>
            )}
            <div className="min-w-0 flex-1 pr-28 sm:pr-56">
              <h2 className="scrollbar-hide max-w-full touch-pan-x overflow-x-auto whitespace-nowrap text-lg font-bold text-[var(--foreground)] sm:truncate sm:overflow-hidden" title={card.title}>
                {card.title}
              </h2>
              {/* Level + strand + alignment row */}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-[0.65rem] text-[var(--muted-foreground)]">
                  Lv <span className="font-bold text-[var(--foreground)]/60">{level}</span>
                </span>
                {previewGameCard?.class && (
                  <span className="text-xs font-medium text-[var(--muted-foreground)]">{previewGameCard.class}</span>
                )}
                {hoshitoActive && hs?.strand && (
                  <span className="text-[0.65rem] text-amber-500/70">{hs.strand.name}</span>
                )}
                {alignStyle && (
                  <span className={cn("inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[0.55rem] font-semibold uppercase tracking-wider border", alignStyle.colorClass)}>
                    {alignStyle.icon}
                    {alignStyle.label}
                  </span>
                )}
              </div>
              {card.mood && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <Heart size={11} className="text-[var(--marinara-chat-chrome-panel-muted)]" />
                  <span className="text-[0.6875rem] italic text-[var(--marinara-chat-chrome-panel-muted)]">{card.mood}</span>
                </div>
              )}
              {card.status && (
                <p className="mt-1 line-clamp-2 text-[0.6875rem] text-[var(--muted-foreground)]">{card.status}</p>
              )}
            </div>
          </div>
          {previewGameCard?.shortDescription && previewGameCard.class && (
            <p className="mt-2 text-[0.6875rem] italic text-[var(--muted-foreground)]">{previewGameCard.shortDescription}</p>
          )}
        </div>

        {/* ── Tabs (only when Hoshito mode AND not editing) ── */}
        {hoshitoActive && !isEditing && (
          <div className="flex shrink-0 border-b border-[var(--marinara-chat-chrome-panel-border)] px-3">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); setEditingSlot(null); }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold transition-colors border-b-2 -mb-px",
                  activeTab === tab.id
                    ? "border-[var(--foreground)]/40 text-[var(--foreground)]"
                    : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]/70",
                )}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {/* ── Content ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── Edit mode (upstream form — always shown when isEditing, regardless of hs) ── */}
          {isEditing && (
            <>
              <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                <SectionHeader icon={<Pencil size={12} />} title="Sheet Details" className="text-[var(--muted-foreground)]" />
                <div className="space-y-3">
                  <label className="block space-y-1.5">
                    <span className={FIELD_LABEL_CLASS}>Class</span>
                    <input type="text" value={draft.class} onChange={(e) => setDraft((p) => ({ ...p, class: e.target.value }))} placeholder="Class or role" className={TEXT_INPUT_CLASS} />
                  </label>
                  <label className="block space-y-1.5">
                    <span className={FIELD_LABEL_CLASS}>Short Description</span>
                    <textarea value={draft.shortDescription} onChange={(e) => setDraft((p) => ({ ...p, shortDescription: e.target.value }))} placeholder="Brief character summary" rows={3} className={cn(TEXT_INPUT_CLASS, "resize-y")} />
                  </label>
                </div>
              </div>

              <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                <div className="mb-2.5 flex items-center justify-between gap-3">
                  <SectionHeader icon={<Sparkles size={12} />} title="Hoshito Stats" className="mb-0 text-[var(--muted-foreground)]" />
                  <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                    <input
                      type="checkbox"
                      checked={draft.hoshitoEnabled}
                      onChange={(e) => setDraft((p) => ({ ...p, hoshitoEnabled: e.target.checked }))}
                      className="h-4 w-4 rounded accent-[var(--foreground)]"
                    />
                    Enable
                  </label>
                </div>
                {draft.hoshitoEnabled ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      <label className="block space-y-1.5">
                        <span className={FIELD_LABEL_CLASS}>Level</span>
                        <DraftNumberInput value={draft.hoshitoLevel} min={1} onCommit={(v) => setDraft((p) => ({ ...p, hoshitoLevel: Math.max(1, v) }))} selectOnFocus className={NUMBER_INPUT_CLASS} />
                      </label>
                      <label className="block space-y-1.5">
                        <span className={FIELD_LABEL_CLASS}>Verve</span>
                        <DraftNumberInput value={draft.hoshitoVerve} min={0} onCommit={(v) => setDraft((p) => ({ ...p, hoshitoVerve: Math.max(0, v) }))} selectOnFocus className={NUMBER_INPUT_CLASS} />
                      </label>
                      <label className="block space-y-1.5">
                        <span className={FIELD_LABEL_CLASS}>Story Points</span>
                        <DraftNumberInput value={draft.hoshitoStoryPoints} min={0} onCommit={(v) => setDraft((p) => ({ ...p, hoshitoStoryPoints: Math.max(0, v) }))} selectOnFocus className={NUMBER_INPUT_CLASS} />
                      </label>
                    </div>

                    <div className="space-y-2">
                      {draft.hoshitoDomains.map((domain, di) => (
                        <div key={di} className="rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] overflow-hidden">
                          <div className="flex items-center gap-2 bg-[var(--marinara-chat-chrome-highlight-bg)] px-3 py-2">
                            <input
                              value={domain.name}
                              onChange={(e) => updateHoshitoDomainName(di, e.target.value)}
                              placeholder="Domain name"
                              className="flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs font-bold uppercase tracking-wide text-[var(--foreground)]/80 outline-none focus:border-[var(--marinara-chat-chrome-input-border-focus)] focus:bg-[var(--marinara-chat-chrome-input-bg)]"
                            />
                            <button
                              type="button"
                              onClick={() => addHoshitoAttr(di)}
                              className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[0.6rem] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--marinara-chat-chrome-button-bg)] transition-colors"
                              title="Add attribute"
                            >
                              <Plus size={11} /> Attr
                            </button>
                            <button
                              type="button"
                              onClick={() => removeHoshitoDomain(di)}
                              className="rounded p-1 text-[var(--muted-foreground)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                              title="Remove domain"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                          <div className="divide-y divide-[var(--marinara-chat-chrome-panel-border)]">
                            {domain.attributes.map((attr, ai) => {
                              const gradeIdx = HOSHITO_GRADE_ORDER.indexOf(attr.grade);
                              const gradeColor = TIER_STYLE[GRADE_TIER[attr.grade]].color;
                              return (
                                <div key={ai} className="flex flex-wrap items-center gap-2 px-3 py-2">
                                  <input
                                    value={attr.name}
                                    onChange={(e) => updateHoshitoAttr(di, ai, "name", e.target.value)}
                                    placeholder="Name"
                                    maxLength={20}
                                    className="w-16 rounded border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-input-bg)] px-1.5 py-1 text-xs font-bold outline-none transition-[width] duration-150 focus:w-28 focus:border-[var(--marinara-chat-chrome-input-border-focus)]"
                                  />
                                  <div className="flex items-center rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-input-bg)]">
                                    <button
                                      type="button"
                                      onClick={() => gradeIdx > 0 && updateHoshitoAttr(di, ai, "grade", HOSHITO_GRADE_ORDER[gradeIdx - 1])}
                                      disabled={gradeIdx <= 0}
                                      className="px-1.5 py-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-20 transition-colors"
                                      title="Lower grade"
                                    >‹</button>
                                    <span className="w-8 select-none text-center text-xs font-mono font-semibold" style={{ color: gradeColor }}>
                                      {displayGrade(attr.grade)}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => gradeIdx < HOSHITO_GRADE_ORDER.length - 1 && updateHoshitoAttr(di, ai, "grade", HOSHITO_GRADE_ORDER[gradeIdx + 1])}
                                      disabled={gradeIdx >= HOSHITO_GRADE_ORDER.length - 1}
                                      className="px-1.5 py-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-20 transition-colors"
                                      title="Raise grade"
                                    >›</button>
                                  </div>
                                  <div className="flex items-center gap-0.5">
                                    {[0, 1, 2].map((i) => (
                                      <button
                                        key={i}
                                        type="button"
                                        onClick={() => updateHoshitoAttr(di, ai, "sparks", attr.sparks === i + 1 ? i : i + 1)}
                                        className="text-sm leading-none"
                                        title={`${i + 1} Spark${i > 0 ? "s" : ""}`}
                                      >
                                        {i < attr.sparks ? <span className="text-amber-400">●</span> : <span className="text-[var(--muted-foreground)]/40">○</span>}
                                      </button>
                                    ))}
                                  </div>
                                  <div className="flex items-center gap-0.5">
                                    <button
                                      type="button"
                                      onClick={() => updateHoshitoAttr(di, ai, "vestigeSparks", Math.max(0, attr.vestigeSparks - 1))}
                                      disabled={attr.vestigeSparks === 0}
                                      className="rounded px-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-30"
                                    >−</button>
                                    <span className="w-4 text-center text-xs font-bold" style={{ color: attr.vestigeSparks > 0 ? "#c084fc" : "var(--muted-foreground)" }} title="Vestige Sparks — permanent">
                                      {attr.vestigeSparks}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => updateHoshitoAttr(di, ai, "vestigeSparks", attr.vestigeSparks + 1)}
                                      className="rounded px-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                                    >+</button>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => updateHoshitoAttr(di, ai, "isExalted", !attr.isExalted)}
                                    title={attr.isExalted ? "Exalted — click to remove" : "Exalt this attribute"}
                                    className={cn("rounded px-1 py-0.5 text-xs transition-colors", attr.isExalted ? "text-amber-500 hover:text-amber-300" : "text-[var(--muted-foreground)]/40 hover:text-amber-500")}
                                  >
                                    {attr.isExalted ? "★" : "☆"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => removeHoshitoAttr(di, ai)}
                                    className="ml-auto rounded p-1 text-[var(--muted-foreground)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                    title="Remove attribute"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={addHoshitoDomain}
                      className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--marinara-chat-chrome-panel-border)] py-2 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--marinara-chat-chrome-highlight-bg)] transition-colors"
                    >
                      <Plus size={13} />
                      Add Domain
                    </button>
                  </div>
                ) : (
                  <p className="text-sm text-[var(--muted-foreground)]">
                    {hs ? "Domains, Grades, and Sparks are preserved while disabled — re-enable any time." : "Enable to track Domains, Grades, and Sparks for this character."}
                  </p>
                )}
              </div>

              <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                <div className="mb-2.5 flex items-center justify-between gap-3">
                  <SectionHeader icon={<BookOpen size={12} />} title="Hoshito Merits" className="mb-0 text-[var(--muted-foreground)]" />
                  {draft.hoshitoEnabled && (
                    <button
                      type="button"
                      onClick={openAddMeritPopup}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--marinara-chat-chrome-panel-border)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)]"
                    >
                      <Plus size={13} /> Add Merit
                    </button>
                  )}
                </div>
                {draft.hoshitoEnabled ? (
                  draft.hoshitoMerits.length > 0 ? (
                    <div className="space-y-3">
                      {draft.hoshitoMerits.map((merit, mi) => {
                        const canGrantSpark = merit.category !== "ability" && merit.category !== "contact";
                        return (
                          <div key={mi} className="rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] p-3 space-y-2">
                            <div className="flex items-center gap-2">
                              <select
                                value={merit.category}
                                onChange={(e) => updateHoshitoMerit(mi, "category", e.target.value)}
                                className="rounded-lg border border-[var(--marinara-chat-chrome-input-border)] bg-[var(--marinara-chat-chrome-input-bg)] px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--foreground)] outline-none focus:border-[var(--marinara-chat-chrome-input-border-focus)]"
                              >
                                {MERIT_CATEGORY_ORDER.map((cat) => (
                                  <option key={cat} value={cat}>{MERIT_CATEGORY_LABELS[cat]}</option>
                                ))}
                              </select>
                              <input
                                type="text"
                                value={merit.name}
                                onChange={(e) => updateHoshitoMerit(mi, "name", e.target.value)}
                                placeholder="Merit name"
                                className={cn(TEXT_INPUT_CLASS, "flex-1 py-1.5")}
                              />
                              <button
                                type="button"
                                onClick={() => removeHoshitoMerit(mi)}
                                className="shrink-0 rounded p-1.5 text-[var(--muted-foreground)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                title="Remove merit"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                            <textarea
                              value={merit.description}
                              onChange={(e) => updateHoshitoMerit(mi, "description", e.target.value)}
                              placeholder="Narrative description — what this Merit does and how it shows up in play"
                              rows={2}
                              className={cn(TEXT_INPUT_CLASS, "resize-y")}
                            />
                            <div className="flex flex-wrap items-center gap-3">
                              {canGrantSpark && (
                                <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-[var(--muted-foreground)]">
                                  <span className="shrink-0">Spark →</span>
                                  <input
                                    type="text"
                                    value={merit.sparkGrantAttribute ?? ""}
                                    onChange={(e) => updateHoshitoMerit(mi, "sparkGrantAttribute", e.target.value)}
                                    placeholder="Attribute name (optional)"
                                    className="min-w-0 flex-1 rounded-lg border border-[var(--marinara-chat-chrome-input-border)] bg-[var(--marinara-chat-chrome-input-bg)] px-2 py-1 text-xs text-[var(--foreground)] outline-none focus:border-[var(--marinara-chat-chrome-input-border-focus)]"
                                  />
                                </label>
                              )}
                              <label className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                                <input
                                  type="checkbox"
                                  checked={!!merit.dormant}
                                  onChange={(e) => updateHoshitoMerit(mi, "dormant", e.target.checked)}
                                  className="h-3.5 w-3.5 rounded accent-[var(--foreground)]"
                                />
                                Dormant
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--muted-foreground)]">No merits yet — add Feats, Artifacts, Abilities, Augments, or Contacts as they're earned in play.</p>
                  )
                ) : (
                  <p className="text-sm text-[var(--muted-foreground)]">
                    {hs?.merits?.length ? "Merits are preserved while Hoshito is disabled — re-enable to edit." : "Enable Hoshito Stats above to track Merits."}
                  </p>
                )}
              </div>

              <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                <div className="mb-2.5 flex items-center justify-between gap-3">
                  <SectionHeader icon={<Star size={12} />} title="Core Merits" className="mb-0 text-[var(--muted-foreground)]" />
                  {draft.hoshitoEnabled && (
                    <button
                      type="button"
                      onClick={openAddCoreMeritPopup}
                      disabled={draft.hoshitoCoreMerits.length >= 3}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--marinara-chat-chrome-panel-border)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Plus size={13} /> Add Core Merit
                    </button>
                  )}
                </div>
                {draft.hoshitoEnabled ? (
                  draft.hoshitoCoreMerits.length > 0 ? (
                    <div className="space-y-3">
                      {draft.hoshitoCoreMerits.map((cm, ci) => (
                        <div key={ci} className="rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <select
                              value={cm.type}
                              onChange={(e) => updateCoreMerit(ci, "type", e.target.value)}
                              className="rounded-lg border border-[var(--marinara-chat-chrome-input-border)] bg-[var(--marinara-chat-chrome-input-bg)] px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-amber-400/80 outline-none focus:border-[var(--marinara-chat-chrome-input-border-focus)]"
                            >
                              {CORE_MERIT_TYPE_ORDER.map((t) => (
                                <option key={t} value={t}>{CORE_MERIT_TYPE_LABELS[t]}</option>
                              ))}
                            </select>
                            {cm.transformations.length > 0 && (
                              <span className="text-[0.625rem] text-violet-400">
                                ×{cm.transformations.length} transformation{cm.transformations.length > 1 ? "s" : ""}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => removeCoreMerit(ci)}
                              className="ml-auto shrink-0 rounded p-1.5 text-[var(--muted-foreground)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                              title="Remove core merit"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                          <textarea
                            value={cm.description}
                            onChange={(e) => updateCoreMerit(ci, "description", e.target.value)}
                            placeholder="Narrative origin — where this came from and what it cost or meant"
                            rows={2}
                            className={cn(TEXT_INPUT_CLASS, "resize-y")}
                          />
                          <div className="flex flex-wrap items-center gap-3">
                            <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-[var(--muted-foreground)]">
                              <span className="shrink-0">Grants Grade step →</span>
                              <input
                                type="text"
                                value={cm.attributeGrant ?? ""}
                                onChange={(e) => updateCoreMerit(ci, "attributeGrant", e.target.value)}
                                disabled={!!cm.grantedSpark}
                                placeholder="Attribute name"
                                className="min-w-0 flex-1 rounded-lg border border-[var(--marinara-chat-chrome-input-border)] bg-[var(--marinara-chat-chrome-input-bg)] px-2 py-1 text-xs text-[var(--foreground)] outline-none focus:border-[var(--marinara-chat-chrome-input-border-focus)] disabled:opacity-40"
                              />
                            </label>
                            <label className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                              <input
                                type="checkbox"
                                checked={!!cm.grantedSpark}
                                onChange={(e) => updateCoreMerit(ci, "grantedSpark", e.target.checked)}
                                className="h-3.5 w-3.5 rounded accent-[var(--foreground)]"
                              />
                              Spark instead (Attribute at D cap)
                            </label>
                          </div>

                          {/* Transformations — earned at Level 7/14/21/26 or a pivotal moment */}
                          <div className="space-y-2 border-t border-[var(--marinara-chat-chrome-panel-border)] pt-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[0.625rem] font-semibold uppercase tracking-widest text-[var(--muted-foreground)]">Transformations</span>
                              <button
                                type="button"
                                onClick={() => addTransformation(ci)}
                                className="inline-flex items-center gap-1 rounded p-1 text-[0.625rem] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)]"
                              >
                                <Plus size={11} /> Add
                              </button>
                            </div>
                            {cm.transformations.map((t, ti) => (
                              <div key={ti} className="space-y-1.5 rounded border border-[var(--marinara-chat-chrome-panel-border)] p-2">
                                <div className="flex items-center gap-1.5">
                                  <select
                                    value={t.merit.category}
                                    onChange={(e) => updateTransformation(ci, ti, "meritCategory", e.target.value)}
                                    className="rounded border border-[var(--marinara-chat-chrome-input-border)] bg-[var(--marinara-chat-chrome-input-bg)] px-1.5 py-1 text-[0.625rem] font-semibold uppercase outline-none"
                                  >
                                    {MERIT_CATEGORY_ORDER.map((cat) => (
                                      <option key={cat} value={cat}>{MERIT_CATEGORY_LABELS[cat]}</option>
                                    ))}
                                  </select>
                                  <input
                                    type="text"
                                    value={t.merit.name}
                                    onChange={(e) => updateTransformation(ci, ti, "meritName", e.target.value)}
                                    placeholder="Merit name"
                                    className="flex-1 rounded border border-[var(--marinara-chat-chrome-input-border)] bg-[var(--marinara-chat-chrome-input-bg)] px-1.5 py-1 text-[0.6875rem] outline-none"
                                  />
                                  <input
                                    type="number"
                                    value={t.level}
                                    onChange={(e) => updateTransformation(ci, ti, "level", e.target.value)}
                                    min={1}
                                    max={26}
                                    className="w-12 shrink-0 rounded border border-[var(--marinara-chat-chrome-input-border)] bg-[var(--marinara-chat-chrome-input-bg)] px-1.5 py-1 text-center text-[0.6875rem] outline-none"
                                    title="Level granted"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => removeTransformation(ci, ti)}
                                    className="shrink-0 rounded p-1 text-[var(--muted-foreground)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                    title="Remove transformation"
                                  >
                                    <X size={11} />
                                  </button>
                                </div>
                                <textarea
                                  value={t.merit.description}
                                  onChange={(e) => updateTransformation(ci, ti, "meritDescription", e.target.value)}
                                  placeholder="What this Merit does"
                                  rows={1}
                                  className="w-full resize-y rounded border border-[var(--marinara-chat-chrome-input-border)] bg-[var(--marinara-chat-chrome-input-bg)] px-1.5 py-1 text-[0.6875rem] outline-none"
                                />
                                <textarea
                                  value={t.narrative}
                                  onChange={(e) => updateTransformation(ci, ti, "narrative", e.target.value)}
                                  placeholder="Narrative — the moment this transformation happened"
                                  rows={1}
                                  className="w-full resize-y rounded border border-[var(--marinara-chat-chrome-input-border)] bg-[var(--marinara-chat-chrome-input-bg)] px-1.5 py-1 text-[0.6875rem] italic outline-none"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--muted-foreground)]">No Core Merits yet — add Ancestry, Heritage, and Background.</p>
                  )
                ) : (
                  <p className="text-sm text-[var(--muted-foreground)]">
                    {hs?.coreMerits?.length ? "Core Merits are preserved while Hoshito is disabled — re-enable to edit." : "Enable Hoshito Stats above to track Core Merits."}
                  </p>
                )}
              </div>

              <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                <div className="mb-2.5 flex items-center justify-between gap-3">
                  <SectionHeader icon={<Shield size={12} />} title="RPG Attributes" className="mb-0 text-[var(--muted-foreground)]" />
                  <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                    <input type="checkbox" checked={draft.rpgStatsEnabled} onChange={(e) => setDraft((p) => ({ ...p, rpgStatsEnabled: e.target.checked }))} className="h-4 w-4 rounded accent-[var(--foreground)]" />
                    Enable
                  </label>
                </div>
                {draft.rpgStatsEnabled ? (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className={FIELD_LABEL_CLASS}>Pools</span>
                        <button
                          onClick={addPool}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--marinara-chat-chrome-panel-border)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)]"
                        >
                          <Plus size={13} />
                          Add Pool
                        </button>
                      </div>
                      {draft.pools.map((pool, index) => (
                        <div
                          key={`${pool.name}-${index}`}
                          className="grid grid-cols-[2rem_minmax(0,1fr)_5rem_5rem_auto] gap-2 max-sm:grid-cols-1"
                        >
                          <input
                            type="color"
                            value={pool.color}
                            onChange={(e) => updatePool(index, { color: e.target.value })}
                            className="h-9 w-8 rounded border border-[var(--marinara-chat-chrome-panel-border)] bg-transparent p-0.5 max-sm:w-full"
                            aria-label={`${pool.name || "Pool"} color`}
                          />
                          <input
                            type="text"
                            value={pool.name}
                            onChange={(e) => updatePool(index, { name: e.target.value })}
                            placeholder="HP"
                            className={TEXT_INPUT_CLASS}
                          />
                          <DraftNumberInput
                            value={pool.value}
                            onCommit={(value) => updatePool(index, { value: Math.max(0, value) })}
                            min={0}
                            selectOnFocus
                            ariaLabel={`${pool.name || "Pool"} value`}
                            className={NUMBER_INPUT_CLASS}
                          />
                          <DraftNumberInput
                            value={pool.max}
                            min={1}
                            onCommit={(value) => updatePool(index, { max: Math.max(1, value) })}
                            selectOnFocus
                            ariaLabel={`${pool.name || "Pool"} max`}
                            className={NUMBER_INPUT_CLASS}
                          />
                          <button
                            onClick={() => removePool(index)}
                            className="inline-flex items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] px-2 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-red-400 max-sm:h-9"
                            title="Remove pool"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="space-y-2">
                      {draft.attributes.map((attr, idx) => (
                        <div key={`${attr.name}-${idx}`} className="grid grid-cols-[minmax(0,1fr)_7rem_auto] gap-2">
                          <input type="text" value={attr.name} onChange={(e) => updateAttribute(idx, "name", e.target.value)} placeholder="STR" className={TEXT_INPUT_CLASS} />
                          <DraftNumberInput value={attr.value} onCommit={(v) => updateAttribute(idx, "value", v)} selectOnFocus className={NUMBER_INPUT_CLASS} />
                          <button onClick={() => removeAttribute(idx)} className="inline-flex items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] px-2 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-red-400" title="Remove attribute">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                      <button onClick={addAttribute} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--marinara-chat-chrome-panel-border)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)]">
                        <Plus size={13} />
                        Add Attribute
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-[var(--muted-foreground)]">Use this when the sheet should track HP and tabletop-style attributes.</p>
                )}
              </div>

              <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                <div className="mb-2.5 flex items-center justify-between gap-3">
                  <SectionHeader icon={<Zap size={12} />} title="Abilities" className="mb-0 text-[var(--muted-foreground)]" />
                  <button onClick={() => addListItem("abilities")} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--marinara-chat-chrome-panel-border)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)]">
                    <Plus size={13} /> Add
                  </button>
                </div>
                <div className="space-y-2">
                  {draft.abilities.map((ability, idx) => (
                    <div key={`ability-${idx}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                      <input type="text" value={ability} onChange={(e) => updateListItem("abilities", idx, e.target.value)} placeholder="Dual-wielding, Arcane shield, etc." className={TEXT_INPUT_CLASS} />
                      <button onClick={() => removeListItem("abilities", idx)} className="inline-flex items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] px-2 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-red-400" title="Remove ability">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <div className="mb-2.5 flex items-center justify-between gap-3">
                      <SectionHeader icon={<Target size={11} />} title="Strengths" className="mb-0 text-emerald-500/80" />
                      <button onClick={() => addListItem("strengths")} className="inline-flex items-center gap-1 rounded-lg border border-dashed border-[var(--marinara-chat-chrome-panel-border)] px-2 py-1 text-[0.6875rem] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)]">
                        <Plus size={12} /> Add
                      </button>
                    </div>
                    <div className="space-y-2">
                      {draft.strengths.map((strength, idx) => (
                        <div key={`strength-${idx}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                          <input type="text" value={strength} onChange={(e) => updateListItem("strengths", idx, e.target.value)} placeholder="Reliable, quick thinker, etc." className={TEXT_INPUT_CLASS} />
                          <button onClick={() => removeListItem("strengths", idx)} className="inline-flex items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] px-2 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-red-400" title="Remove">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="mb-2.5 flex items-center justify-between gap-3">
                      <SectionHeader icon={<AlertTriangle size={11} />} title="Weaknesses" className="mb-0 text-red-400/80" />
                      <button onClick={() => addListItem("weaknesses")} className="inline-flex items-center gap-1 rounded-lg border border-dashed border-[var(--marinara-chat-chrome-panel-border)] px-2 py-1 text-[0.6875rem] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)]">
                        <Plus size={12} /> Add
                      </button>
                    </div>
                    <div className="space-y-2">
                      {draft.weaknesses.map((weakness, idx) => (
                        <div key={`weakness-${idx}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                          <input type="text" value={weakness} onChange={(e) => updateListItem("weaknesses", idx, e.target.value)} placeholder="Impulsive, poor swimmer, etc." className={TEXT_INPUT_CLASS} />
                          <button onClick={() => removeListItem("weaknesses", idx)} className="inline-flex items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] px-2 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-red-400" title="Remove">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                <div className="mb-2.5 flex items-center justify-between gap-3">
                  <SectionHeader icon={<Info size={12} />} title="Details" className="mb-0 text-[var(--muted-foreground)]" />
                  <button onClick={addExtraEntry} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--marinara-chat-chrome-panel-border)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)]">
                    <Plus size={13} /> Add Detail
                  </button>
                </div>
                <p className="mb-3 text-[0.6875rem] text-[var(--muted-foreground)]">Add custom details like Skills, Weapon, Element, Specialty, or Faction.</p>
                <div className="space-y-2">
                  {draft.extraEntries.map((entry, idx) => (
                    <div key={`extra-${idx}`} className="grid grid-cols-[10rem_minmax(0,1fr)_auto] gap-2 max-sm:grid-cols-1">
                      <input type="text" value={entry.key} onChange={(e) => updateExtraEntry(idx, "key", e.target.value)} placeholder="Skills" className={TEXT_INPUT_CLASS} />
                      <input type="text" value={entry.value} onChange={(e) => updateExtraEntry(idx, "value", e.target.value)} placeholder="Lockpicking, survival, marksmanship" className={TEXT_INPUT_CLASS} />
                      <button onClick={() => removeExtraEntry(idx)} className="inline-flex items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] px-2 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-red-400 max-sm:h-10" title="Remove">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── Hoshito view mode ── */}
          {!isEditing && hoshitoActive && hs && (
            <>
              {/* Sheet tab */}
              {activeTab === "sheet" && (
                <div className="flex flex-col gap-3 p-4">
                  {/* Domains */}
                  {hs.domains.map((domain, di) => (
                    <DomainCard
                      key={domain.name}
                      domain={domain}
                      index={di}
                      level={level}
                      primaryAttrName={hs.strand?.primaryAttribute}
                    />
                  ))}

                  <div className="border-t border-white/[0.06]" />

                  {/* Derived stats */}
                  <div>
                    <p className="mb-2 text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-600">Derived Stats</p>
                    <DerivedStatsPanel s={hs} />
                  </div>

                  {/* Resistance profile */}
                  {hs.resistances && hs.resistances.length > 0 && (
                    <>
                      <div className="border-t border-white/[0.06]" />
                      <div>
                        <p className="mb-2 text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-600">Resistance Profile</p>
                        <div className="flex flex-col gap-1.5">
                          {hs.resistances.map((entry) => (
                            <div key={entry.type} className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
                              <div className="flex items-center gap-3">
                                <span className={cn("text-xs font-bold w-20 shrink-0", DAMAGE_TYPE_COLOR[entry.type])}>{entry.type}</span>
                                <div className="flex-1 grid grid-cols-2 gap-2 text-[0.6rem]">
                                  <div>
                                    <span className="text-neutral-600">HP: </span>
                                    <span className={RESISTANCE_TIER_COLOR[entry.healthTier]}>{entry.healthTier} ×{HOSHITO_RESISTANCE_MULTIPLIERS[entry.healthTier]}</span>
                                  </div>
                                  <div>
                                    <span className="text-neutral-600">Stagger: </span>
                                    <span className={RESISTANCE_TIER_COLOR[entry.staggerTier]}>{entry.staggerTier} ×{HOSHITO_RESISTANCE_MULTIPLIERS[entry.staggerTier]}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}

                  {/* Legacy RPG Attributes */}
                  {card.gameCard?.rpgStats && (
                    <>
                      <div className="border-t border-white/[0.06]" />
                      <RpgAttributesView rpgStats={card.gameCard.rpgStats} />
                    </>
                  )}

                  {/* Upstream stats / inventory / customFields */}
                  {card.stats && card.stats.length > 0 && (
                    <>
                      <div className="border-t border-white/[0.06]" />
                      <div>
                        <p className="mb-2 text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-600">Stats</p>
                        <div className="space-y-2">
                          {card.stats.map((stat) => {
                            const max = Math.max(1, stat.max ?? 100);
                            const val = Math.max(0, Math.min(max, stat.value));
                            return (
                              <div key={stat.name}>
                                <div className="mb-0.5 flex items-center justify-between text-xs">
                                  <span className="font-medium text-[var(--foreground)]/80">{stat.name}</span>
                                  <span className="font-mono text-[var(--muted-foreground)]">{val}/{max}</span>
                                </div>
                                <div className="h-2 overflow-hidden rounded-full bg-[var(--marinara-chat-chrome-highlight-bg)] ring-1 ring-[var(--marinara-chat-chrome-panel-border)]">
                                  <div className="h-full rounded-full transition-all" style={{ width: `${(val / max) * 100}%`, background: stat.color || "var(--foreground)" }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
              {hasRpgPools && (
                <div className="space-y-2">
                  {previewRpgPools.map((pool) => {
                    const poolMax = Math.max(1, Number(pool.max) || 1);
                    const poolValue = Math.max(0, Math.min(poolMax, Number(pool.value) || 0));
                    return (
                      <div key={pool.name}>
                        <div className="mb-0.5 flex items-center justify-between text-xs">
                          <span className="font-medium text-[var(--foreground)]/80">{pool.name}</span>
                          <span className="font-mono text-[var(--muted-foreground)]">
                            {poolValue}/{poolMax}
                          </span>
                        </div>
                        <div className="h-2.5 overflow-hidden rounded-full bg-[var(--marinara-chat-chrome-highlight-bg)] ring-1 ring-[var(--marinara-chat-chrome-panel-border)]">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${(poolValue / poolMax) * 100}%`,
                              background: pool.color,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Actions tab */}
              {activeTab === "actions" && (
                <div className="flex flex-col gap-4 p-4">
                  <p className="text-[0.625rem] text-neutral-600 text-center">
                    {editingSlot ? "Tap Save or click outside to confirm." : "Customize at Character Creation or Long Rest."}
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {SLOT_KEYS.map((key) => (
                      <DefaultActionCard
                        key={key}
                        slotKey={key}
                        action={defaultActions[key]}
                        nameLibrary={nameLibrary}
                        isEditing={editingSlot === key}
                        onStartEdit={() => setEditingSlot(key)}
                        onSave={(updated) => handleSaveAction(key, updated)}
                      />
                    ))}
                  </div>
                  {nameLibrary.length > 0 && (
                    <div className="border-t border-white/[0.06] pt-3">
                      <p className="mb-2 text-[0.575rem] font-semibold uppercase tracking-widest text-neutral-600">Previously Used Names</p>
                      <div className="flex flex-wrap gap-1">
                        {nameLibrary.map((tag) => (
                          <span key={tag} className="rounded-full border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 text-[0.575rem] text-neutral-500">{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Merits tab */}
              {activeTab === "merits" && (
                <div className="flex flex-col gap-5 p-4">
                  <div>
                    <p className="mb-2 text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-600">Strand</p>
                    <StrandSection s={hs} />
                  </div>
                  <div className="border-t border-white/[0.06]" />
                  <div>
                    <p className="mb-2 text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-600">Merits</p>
                    <MeritsSection s={hs} />
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Non-Hoshito view mode (upstream layout) ── */}
          {!isEditing && !hoshitoActive && (
            <>
              {/* Initialize Sheet prompt — only for sessions with no Hoshito data at all
                  (migrated from the parent repo). Never shown when hs exists but is merely
                  toggled off, since Initialize would overwrite real domains with a blank one. */}
              {onSave && !hs && (
                <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-6">
                  <div className="flex flex-col items-center gap-3 text-center">
                    <Target size={24} className="text-[var(--muted-foreground)]/40" />
                    <p className="text-sm text-[var(--muted-foreground)]">No Hoshito character data found.</p>
                    <p className="text-xs text-[var(--muted-foreground)]/70">
                      Initialize a blank sheet with the default domain layout. You can edit domains and attributes freely in the Persona Editor after.
                    </p>
                    <button
                      type="button"
                      disabled={isSaving}
                      onClick={async () => {
                        if (isSaving) return;
                        const blank: HoshitoCharacterStats = {
                          enabled: true,
                          level: 1,
                          domains: [
                            { name: "Physical", attributes: [
                              { name: "MIG", grade: "F", sparks: 0, vestigeSparks: 0 },
                              { name: "AGI", grade: "F", sparks: 0, vestigeSparks: 0 },
                              { name: "VIT", grade: "F", sparks: 0, vestigeSparks: 0 },
                            ]},
                            { name: "Mental", attributes: [
                              { name: "INT", grade: "F", sparks: 0, vestigeSparks: 0 },
                              { name: "INS", grade: "F", sparks: 0, vestigeSparks: 0 },
                              { name: "WIL", grade: "F", sparks: 0, vestigeSparks: 0 },
                            ]},
                            { name: "Social", attributes: [
                              { name: "APP", grade: "F", sparks: 0, vestigeSparks: 0 },
                              { name: "EMP", grade: "F", sparks: 0, vestigeSparks: 0 },
                              { name: "PSY", grade: "F", sparks: 0, vestigeSparks: 0 },
                            ]},
                          ],
                          verve: 1,
                          storyPoints: 0,
                          defaultActions: HOSHITO_DEFAULT_ACTIONS,
                        };
                        setIsSaving(true);
                        try {
                          await onSave(card.gameCard, blank);
                          onClose();
                        } finally {
                          setIsSaving(false);
                        }
                      }}
                      className="mt-1 rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-button-bg)] px-4 py-2 text-xs font-semibold text-[var(--foreground)] hover:bg-[var(--marinara-chat-chrome-highlight-bg)] disabled:opacity-40 transition-colors"
                    >
                      {isSaving ? "Initializing…" : "Initialize Sheet"}
                    </button>
                  </div>
                  {/* Show legacy RPG attrs if present */}
                  {card.gameCard?.rpgStats && (
                    <div className="mt-4">
                      <RpgAttributesView rpgStats={card.gameCard.rpgStats} />
                    </div>
                  )}
                </div>
              )}

              {/* Hoshito disabled (data preserved) — distinct from "no data", so Initialize
                  is never offered here. Re-enabling happens in Edit Sheet, not via a button. */}
              {onSave && hs && (
                <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-6">
                  <div className="flex flex-col items-center gap-2 text-center">
                    <Target size={24} className="text-[var(--muted-foreground)]/40" />
                    <p className="text-sm text-[var(--muted-foreground)]">Hoshito tracking is turned off for this character.</p>
                    <p className="text-xs text-[var(--muted-foreground)]/70">
                      Domains and Grades are preserved. Use Edit Sheet to turn it back on.
                    </p>
                  </div>
                  {card.gameCard?.rpgStats && (
                    <div className="mt-4">
                      <RpgAttributesView rpgStats={card.gameCard.rpgStats} />
                    </div>
                  )}
                </div>
              )}

              {/* RPG Attributes view (non-editing) */}
              {!onSave && hasRpgStats && previewGameCard?.rpgStats && (
                <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                  <SectionHeader icon={<Shield size={12} />} title="Attributes" className="text-[var(--muted-foreground)]" />
                  {hasRpgAttributes && (
                    <div className="mb-3 grid grid-cols-3 gap-2">
                      {previewGameCard.rpgStats.attributes.map((attr) => (
                        <div key={attr.name} className="flex flex-col items-center rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-highlight-bg)] px-2 py-1.5">
                          <span className="text-[0.5625rem] font-bold uppercase tracking-widest text-[var(--muted-foreground)]">{attr.name}</span>
                          <span className="text-lg font-bold leading-tight text-[var(--foreground)]">{attr.value}</span>
                          <span className="text-[0.625rem] font-mono leading-none text-[var(--muted-foreground)]">{formatAttributeModifier(attr.value)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Stats */}
              {card.stats && card.stats.length > 0 && (
                <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                  <SectionHeader icon={<Shield size={12} />} title="Stats" className="text-[var(--muted-foreground)]" />
                  <div className="space-y-2">
                    {card.stats.map((stat) => {
                      const max = Math.max(1, stat.max ?? 100);
                      const val = Math.max(0, Math.min(max, stat.value));
                      return (
                        <div key={stat.name}>
                          <div className="mb-0.5 flex items-center justify-between text-xs">
                            <span className="font-medium text-[var(--foreground)]/80">{stat.name}</span>
                            <span className="font-mono text-[var(--muted-foreground)]">{val}/{max}</span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-[var(--marinara-chat-chrome-highlight-bg)] ring-1 ring-[var(--marinara-chat-chrome-panel-border)]">
                            <div className="h-full rounded-full transition-all" style={{ width: `${(val / max) * 100}%`, background: stat.color || "var(--foreground)" }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Abilities */}
              {previewGameCard && previewGameCard.abilities.length > 0 && (
                <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                  <SectionHeader icon={<Zap size={12} />} title="Abilities" className="text-[var(--muted-foreground)]" />
                  <div className="space-y-1">
                    {previewGameCard.abilities.map((ability, idx) => (
                      <div key={`${ability}-${idx}`} className="rounded-lg bg-[var(--marinara-chat-chrome-highlight-bg)] px-2.5 py-1.5 text-xs text-[var(--foreground)]/80">{ability}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Strengths / Weaknesses */}
              {previewGameCard && (previewGameCard.strengths.length > 0 || previewGameCard.weaknesses.length > 0) && (
                <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                  <div className="grid grid-cols-2 gap-3">
                    {previewGameCard.strengths.length > 0 && (
                      <div>
                        <SectionHeader icon={<Target size={11} />} title="Strengths" className="text-emerald-500/80" />
                        <div className="space-y-0.5">
                          {previewGameCard.strengths.map((s, i) => (
                            <div key={`${s}-${i}`} className="text-[0.6875rem] text-[var(--foreground)]/70">• {s}</div>
                          ))}
                        </div>
                      </div>
                    )}
                    {previewGameCard.weaknesses.length > 0 && (
                      <div>
                        <SectionHeader icon={<AlertTriangle size={11} />} title="Weaknesses" className="text-red-400/80" />
                        <div className="space-y-0.5">
                          {previewGameCard.weaknesses.map((w, i) => (
                            <div key={`${w}-${i}`} className="text-[0.6875rem] text-[var(--foreground)]/70">• {w}</div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Details (extra) */}
              {previewGameCard && Object.keys(previewGameCard.extra).length > 0 && (
                <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                  <SectionHeader icon={<Info size={12} />} title="Details" className="text-[var(--muted-foreground)]" />
                  <div className="space-y-1.5 text-xs">
                    {Object.entries(previewGameCard.extra).map(([k, v]) => (
                      <div key={k} className="flex items-start justify-between gap-3">
                        <span className="shrink-0 capitalize text-[var(--muted-foreground)]">{k.replaceAll("_", " ")}</span>
                        <span className="text-right text-[var(--foreground)]/80">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Inventory */}
              {card.inventory && card.inventory.length > 0 && (
                <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                  <SectionHeader icon={<Swords size={12} />} title="Inventory" className="text-[var(--muted-foreground)]" />
                  <div className="space-y-1">
                    {card.inventory.map((item) => (
                      <div key={`${item.name}-${item.location ?? "bag"}`} className="flex items-center justify-between rounded-lg bg-[var(--marinara-chat-chrome-highlight-bg)] px-2.5 py-1.5 text-xs">
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                          <span className="min-w-0 whitespace-normal break-words text-[var(--foreground)]/80 [overflow-wrap:anywhere]">{item.name}</span>
                          {item.location && (
                            <span className="rounded bg-[var(--foreground)]/10 px-1.5 py-0.5 text-[0.5625rem] text-[var(--muted-foreground)]">{item.location}</span>
                          )}
                        </div>
                        {item.quantity != null && item.quantity > 1 && (
                          <span className="font-mono text-[var(--muted-foreground)]">x{item.quantity}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Custom fields */}
              {card.customFields && Object.keys(card.customFields).length > 0 && (
                <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-5 py-4">
                  <SectionHeader icon={<Sparkles size={12} />} title="Traits" className="text-[var(--muted-foreground)]" />
                  <div className="space-y-1.5 text-xs">
                    {Object.entries(card.customFields).map(([k, v]) => (
                      <div key={k} className="flex items-start justify-between gap-3">
                        <span className="shrink-0 text-[var(--muted-foreground)]">{k}</span>
                        <span className="text-right text-[var(--foreground)]/80">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!hasAnyData && !onSave && (
                <div className="px-5 py-8 text-center">
                  <p className="text-sm text-[var(--muted-foreground)]">Character data will populate as the story progresses.</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>

    {/* ── Add Merit popup ── */}
    {showAddMeritPopup && (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm"
        onClick={cancelAddMeritPopup}
      >
        <div
          className={cn(
            NEUTRAL_SURFACE_VARIABLES,
            "marinara-chat-popover relative flex max-h-[85vh] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-panel-bg)] shadow-2xl",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-4 py-3">
            <SectionHeader icon={<BookOpen size={12} />} title="Add Merit" className="mb-0 text-[var(--muted-foreground)]" />
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3.5">
            {/* Category — list of selection, not a dropdown */}
            <div>
              <span className={cn(FIELD_LABEL_CLASS, "mb-1.5 block")}>Category</span>
              <div className="overflow-hidden rounded-lg border border-[var(--marinara-chat-chrome-panel-border)]">
                {MERIT_CATEGORY_ORDER.map((cat, ci) => {
                  const selected = newMeritDraft.category === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setNewMeritDraft((p) => ({ ...p, category: cat }))}
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors",
                        ci > 0 && "border-t border-[var(--marinara-chat-chrome-panel-border)]",
                        selected
                          ? "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--foreground)] font-semibold"
                          : "text-[var(--muted-foreground)] hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)]",
                      )}
                    >
                      {MERIT_CATEGORY_LABELS[cat]}
                      {selected && <Check size={14} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="block space-y-1.5">
              <span className={FIELD_LABEL_CLASS}>Name</span>
              <input
                type="text"
                autoFocus
                value={newMeritDraft.name}
                onChange={(e) => setNewMeritDraft((p) => ({ ...p, name: e.target.value }))}
                placeholder="Merit name"
                className={TEXT_INPUT_CLASS}
              />
            </label>

            <label className="block space-y-1.5">
              <span className={FIELD_LABEL_CLASS}>Description <span className="normal-case font-normal text-[var(--muted-foreground)]/70">(optional)</span></span>
              <textarea
                value={newMeritDraft.description}
                onChange={(e) => setNewMeritDraft((p) => ({ ...p, description: e.target.value }))}
                placeholder="What this Merit does and how it shows up in play"
                rows={2}
                className={cn(TEXT_INPUT_CLASS, "resize-y")}
              />
            </label>

            {newMeritDraft.category !== "ability" && newMeritDraft.category !== "contact" && (
              <label className="block space-y-1.5">
                <span className={FIELD_LABEL_CLASS}>Spark Grant <span className="normal-case font-normal text-[var(--muted-foreground)]/70">(optional)</span></span>
                <input
                  type="text"
                  value={newMeritDraft.sparkGrantAttribute}
                  onChange={(e) => setNewMeritDraft((p) => ({ ...p, sparkGrantAttribute: e.target.value }))}
                  placeholder="Attribute name"
                  className={TEXT_INPUT_CLASS}
                />
              </label>
            )}

            <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
              <input
                type="checkbox"
                checked={newMeritDraft.dormant}
                onChange={(e) => setNewMeritDraft((p) => ({ ...p, dormant: e.target.checked }))}
                className="h-3.5 w-3.5 rounded accent-[var(--foreground)]"
              />
              Dormant
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[var(--marinara-chat-chrome-panel-border)] px-4 py-3">
            <button
              type="button"
              onClick={cancelAddMeritPopup}
              className="inline-flex items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-button-bg)] px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmAddMerit}
              disabled={!newMeritDraft.name.trim() && !newMeritDraft.description.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--marinara-chat-chrome-highlight-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] ring-1 ring-[var(--marinara-chat-chrome-panel-border)] transition-colors hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={13} /> Add
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── Add Core Merit popup ── */}
    {showAddCoreMeritPopup && (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm"
        onClick={cancelAddCoreMeritPopup}
      >
        <div
          className={cn(
            NEUTRAL_SURFACE_VARIABLES,
            "marinara-chat-popover relative flex max-h-[85vh] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-panel-bg)] shadow-2xl",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="border-b border-[var(--marinara-chat-chrome-panel-border)] px-4 py-3">
            <SectionHeader icon={<Star size={12} />} title="Add Core Merit" className="mb-0 text-[var(--muted-foreground)]" />
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3.5">
            <div>
              <span className={cn(FIELD_LABEL_CLASS, "mb-1.5 block")}>Type</span>
              <div className="overflow-hidden rounded-lg border border-[var(--marinara-chat-chrome-panel-border)]">
                {CORE_MERIT_TYPE_ORDER.map((t, ti) => {
                  const selected = newCoreMeritDraft.type === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setNewCoreMeritDraft((p) => ({ ...p, type: t }))}
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors",
                        ti > 0 && "border-t border-[var(--marinara-chat-chrome-panel-border)]",
                        selected
                          ? "bg-[var(--marinara-chat-chrome-highlight-bg)] font-semibold text-[var(--foreground)]"
                          : "text-[var(--muted-foreground)] hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)]",
                      )}
                    >
                      {CORE_MERIT_TYPE_LABELS[t]}
                      {selected && <Check size={14} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="block space-y-1.5">
              <span className={FIELD_LABEL_CLASS}>Description</span>
              <textarea
                autoFocus
                value={newCoreMeritDraft.description}
                onChange={(e) => setNewCoreMeritDraft((p) => ({ ...p, description: e.target.value }))}
                placeholder="Narrative origin — where this came from and what it cost or meant. Specific origins produce resonant transformations later."
                rows={3}
                className={cn(TEXT_INPUT_CLASS, "resize-y")}
              />
            </label>

            <label className="block space-y-1.5">
              <span className={FIELD_LABEL_CLASS}>
                Grants Grade Step <span className="font-normal normal-case text-[var(--muted-foreground)]/70">(optional)</span>
              </span>
              <input
                type="text"
                value={newCoreMeritDraft.attributeGrant}
                onChange={(e) => setNewCoreMeritDraft((p) => ({ ...p, attributeGrant: e.target.value }))}
                disabled={newCoreMeritDraft.grantedSpark}
                placeholder="Attribute name"
                className={cn(TEXT_INPUT_CLASS, "disabled:opacity-40")}
              />
            </label>

            <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
              <input
                type="checkbox"
                checked={newCoreMeritDraft.grantedSpark}
                onChange={(e) => setNewCoreMeritDraft((p) => ({ ...p, grantedSpark: e.target.checked }))}
                className="h-3.5 w-3.5 rounded accent-[var(--foreground)]"
              />
              Grant 1 Spark instead (Attribute already at Grade D cap)
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[var(--marinara-chat-chrome-panel-border)] px-4 py-3">
            <button
              type="button"
              onClick={cancelAddCoreMeritPopup}
              className="inline-flex items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-button-bg)] px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--foreground)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmAddCoreMerit}
              disabled={!newCoreMeritDraft.description.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--marinara-chat-chrome-highlight-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] ring-1 ring-[var(--marinara-chat-chrome-panel-border)] transition-colors hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={13} /> Add
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
