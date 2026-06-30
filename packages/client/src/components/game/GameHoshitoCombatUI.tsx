// ──────────────────────────────────────────────
// Hoshito's Marinara Engine — Combat UI
// Segment 3: Full replacement for GameCombatUI when
// hoshitoStats are present on the player's character.
//
// Features:
//   • Dual Health / Stagger bars per combatant
//   • AP pips, Coins, Speed Dice pool
//   • Per-combatant Morale indicator with Power modifier
//   • Initiative queue (by Speed Die result)
//   • Three Limbus-style named action cards (Melee / Ranged / Defensive)
//   • Clash resolver — toggle: Focused (overlay) or Inline (panel)
//   • Incoming attack prompt (spend Speed Die or take it)
//   • Scrollable combat log
//   • Settings drawer (clash mode toggle)
// ──────────────────────────────────────────────
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ChevronDown,
  Coins,
  Settings,
  Shield,
  Swords,
  Target,
  X,
  Zap,
} from "lucide-react";
import type {
  HoshitoCombatState,
  HoshitoCombatant,
  HoshitoClashResult,
  HoshitoDefaultActions,
  HoshitoEncounterActionResponse,
  HoshitoPlayerAction,
  HoshitoStatusEffect,
} from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import { NEUTRAL_SURFACE_VARIABLES } from "../ui/neutral-surface-styles";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

type ClashMode = "focused" | "inline";

type CombatPhase =
  | "player_turn"
  | "awaiting_result"
  | "incoming_attack"
  | "clash_display"
  | "victory"
  | "defeat";

interface CombatLogEntry {
  id: string;
  text: string;
  type: "action" | "clash" | "morale" | "stagger" | "system" | "result";
}

interface PendingIncomingAttack {
  attackerName: string;
  attackerPower: number;
  healthDamage: number;
  staggerDamage: number;
}

export interface GameHoshitoCombatUIProps {
  chatId: string;
  initialCombatState: HoshitoCombatState;
  defaultActions: HoshitoDefaultActions;
  onPlayerAction: (action: HoshitoPlayerAction, currentState: HoshitoCombatState) => Promise<HoshitoEncounterActionResponse>;
  onCombatEnd: (outcome: "victory" | "defeat" | "fled", narrative: string) => void;
  narration?: string;
  gameVoiceVolume?: number;
  combatControlsSlot?: ReactNode;
}

type SlotKey = "melee" | "ranged" | "defensive";

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const MORALE_THRESHOLDS = [15, 30, 45] as const;

function getMoraleModifier(morale: number): number {
  const abs = Math.abs(morale);
  const sign = morale >= 0 ? 1 : -1;
  if (abs >= 45) return sign * 3;
  if (abs >= 30) return sign * 2;
  if (abs >= 15) return sign * 1;
  return 0;
}

function getMoraleLabel(morale: number): string {
  const abs = Math.abs(morale);
  const dir = morale >= 0 ? "High" : "Low";
  if (abs === 0) return "Neutral";
  if (abs < 15) return `${dir} I`;
  if (abs < 30) return `${dir} II`;
  if (abs < 45) return `${dir} III`;
  return `${dir} MAX`;
}

const ACTION_TYPE_LABELS: Record<string, string> = {
  HMW: "Heavy Melee",
  LMW: "Light Melee",
  MeleeCantrip: "Melee Cantrip",
  Unarmed: "Unarmed",
  Marksmanship: "Marksmanship",
  SpellCantrip: "Spell / Cantrip",
  Evade: "Evade",
  Guard: "Guard",
  PowerGuard: "Power Guard",
};

const SLOT_META: Record<
  SlotKey,
  { label: string; icon: ReactNode; headerClass: string; borderClass: string; ringClass: string }
> = {
  melee: {
    label: "Melee",
    icon: <Swords size={11} />,
    headerClass: "text-orange-400",
    borderClass: "border-orange-900/50",
    ringClass: "ring-orange-500/40",
  },
  ranged: {
    label: "Ranged",
    icon: <Target size={11} />,
    headerClass: "text-sky-400",
    borderClass: "border-sky-900/50",
    ringClass: "ring-sky-500/40",
  },
  defensive: {
    label: "Defense",
    icon: <Shield size={11} />,
    headerClass: "text-teal-400",
    borderClass: "border-teal-900/50",
    ringClass: "ring-teal-500/40",
  },
};

// ──────────────────────────────────────────────
// Resource components
// ──────────────────────────────────────────────

function HealthStaggerBars({
  health,
  healthMax,
  stagger,
  staggerMax,
  isStaggered,
}: Pick<HoshitoCombatant, "health" | "healthMax" | "stagger" | "staggerMax" | "isStaggered">) {
  const hPct = Math.max(0, Math.min(100, (health / Math.max(healthMax, 1)) * 100));
  const sPct = Math.max(0, Math.min(100, (stagger / Math.max(staggerMax, 1)) * 100));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="w-6 shrink-0 text-right text-[0.55rem] font-semibold text-red-400/80">HP</span>
        <div className="relative flex-1 h-2 rounded-full bg-white/[0.06] overflow-hidden">
          <div
            className="h-full rounded-full bg-red-600 transition-all duration-300"
            style={{ width: `${hPct}%` }}
          />
        </div>
        <span className="w-14 shrink-0 text-right text-[0.6rem] font-mono text-red-400">
          {health}/{healthMax}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-6 shrink-0 text-right text-[0.55rem] font-semibold text-blue-400/80">
          SGR
        </span>
        <div className="relative flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              isStaggered ? "bg-red-500/60" : "bg-blue-500",
            )}
            style={{ width: `${sPct}%` }}
          />
        </div>
        <span className="w-14 shrink-0 text-right text-[0.6rem] font-mono text-blue-400">
          {stagger}/{staggerMax}
        </span>
      </div>
    </div>
  );
}

function APPips({ ap, apMax }: { ap: number; apMax: number }) {
  return (
    <div className="flex items-center gap-0.5" title={`${ap}/${apMax} AP`}>
      {Array.from({ length: apMax }, (_, i) => (
        <div
          key={i}
          className={cn("h-2 w-2 rounded-sm transition-colors", i < ap ? "bg-yellow-400" : "bg-white/[0.08]")}
        />
      ))}
    </div>
  );
}

function CoinTracker({ coins }: { coins: number }) {
  return (
    <div className="flex items-center gap-0.5" title={`${coins} Coins`}>
      {Array.from({ length: 3 }, (_, i) => (
        <span
          key={i}
          className={cn("text-sm leading-none", i < coins ? "text-amber-400" : "text-white/[0.12]")}
        >
          ◈
        </span>
      ))}
    </div>
  );
}

function SpeedDicePool({
  pool,
}: {
  pool: HoshitoCombatant["speedDice"];
}) {
  return (
    <div className="flex items-center gap-1" title="Speed Dice">
      {Array.from({ length: pool.total }, (_, i) => (
        <div
          key={i}
          className={cn(
            "rounded border px-1 py-0.5 text-[0.55rem] font-mono font-bold leading-none transition-all",
            i < pool.remaining
              ? "border-teal-700/60 bg-teal-950/50 text-teal-300"
              : "border-white/[0.06] bg-transparent text-white/[0.12]",
          )}
        >
          {pool.dieType}
        </div>
      ))}
    </div>
  );
}

function MoraleIndicator({ morale }: { morale: number }) {
  const mod = getMoraleModifier(morale);
  const isPos = morale > 0;
  const isNeg = morale < 0;
  const label = getMoraleLabel(morale);
  return (
    <div className="flex items-center gap-1">
      <span className="text-[0.55rem] text-neutral-600">MRL</span>
      <span
        className={cn(
          "text-[0.65rem] font-mono font-bold",
          isPos ? "text-teal-400" : isNeg ? "text-red-400" : "text-neutral-500",
        )}
      >
        {morale > 0 ? `+${morale}` : morale}
      </span>
      <span className="text-[0.55rem] text-neutral-600">{label}</span>
      {mod !== 0 && (
        <span
          className={cn(
            "rounded px-0.5 text-[0.55rem] font-bold",
            mod > 0 ? "bg-teal-900/50 text-teal-300" : "bg-red-900/50 text-red-300",
          )}
        >
          {mod > 0 ? `+${mod}` : mod}
        </span>
      )}
    </div>
  );
}

function StatusBadges({ effects }: { effects: HoshitoStatusEffect[] }) {
  if (!effects.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {effects.map((e) => (
        <span
          key={e.name}
          className={cn(
            "rounded-full border px-1.5 py-0.5 text-[0.55rem] font-semibold",
            e.type === "Buff"
              ? "border-teal-800 bg-teal-950/50 text-teal-300"
              : e.type === "Debuff"
                ? "border-red-800 bg-red-950/50 text-red-300"
                : "border-white/10 bg-white/[0.04] text-neutral-400",
          )}
          title={e.effect}
        >
          {e.name}
          {e.stackable && e.count > 1 ? ` ×${e.count}` : ""}
        </span>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────
// CombatantCard
// ──────────────────────────────────────────────

function CombatantCard({
  combatant,
  isActive,
  onTarget,
  targetable,
}: {
  combatant: HoshitoCombatant;
  isActive: boolean;
  onTarget?: () => void;
  targetable?: boolean;
}) {
  const { name, health, healthMax, stagger, staggerMax, ap, apMax, coins, morale, speedDice, isStaggered, statusEffects, isPlayer, sprite } = combatant;

  return (
    <div
      className={cn(
        "relative flex min-w-[180px] max-w-[220px] flex-col gap-2 rounded-xl border p-3 transition-all",
        isPlayer
          ? "border-blue-900/50 bg-blue-950/10"
          : "border-red-900/50 bg-red-950/10",
        isActive && "ring-1 ring-amber-400/40",
        isStaggered && "ring-1 ring-red-500/50",
        targetable && "cursor-pointer hover:ring-1 hover:ring-white/20",
      )}
      onClick={targetable ? onTarget : undefined}
    >
      {/* Name + avatar row */}
      <div className="flex items-center gap-2">
        {sprite && (
          <img
            src={sprite}
            alt={name}
            className="h-8 w-8 shrink-0 rounded-lg object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-bold text-white/90">{name}</p>
          {isStaggered && (
            <p className="text-[0.55rem] font-bold uppercase tracking-wider text-red-400">
              ✦ Staggered
            </p>
          )}
          {isActive && !isStaggered && (
            <p className="text-[0.55rem] font-bold uppercase tracking-wider text-amber-400">
              Active
            </p>
          )}
        </div>
      </div>

      {/* HP + Stagger bars */}
      <HealthStaggerBars
        health={health}
        healthMax={healthMax}
        stagger={stagger}
        staggerMax={staggerMax}
        isStaggered={isStaggered}
      />

      {/* Resource row */}
      <div className="flex items-center justify-between gap-1">
        <APPips ap={ap} apMax={apMax} />
        <CoinTracker coins={coins} />
        <SpeedDicePool pool={speedDice} />
      </div>

      {/* Morale */}
      <MoraleIndicator morale={morale} />

      {/* Status effects */}
      <StatusBadges effects={statusEffects} />

      {/* Target indicator */}
      {targetable && (
        <div className="absolute -top-1.5 -right-1.5 h-3 w-3 rounded-full bg-red-500 ring-2 ring-red-900/50" />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// InitiativeQueueBar
// ──────────────────────────────────────────────

function InitiativeQueueBar({
  queue,
  round,
}: {
  queue: HoshitoCombatState["initiativeQueue"];
  round: number;
}) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto px-3 py-2 border-b border-white/[0.06] shrink-0">
      <span className="shrink-0 text-[0.6rem] font-semibold uppercase tracking-wider text-neutral-600">
        Round {round}
      </span>
      <span className="text-neutral-700 shrink-0">·</span>
      {queue.map((entry: HoshitoCombatState["initiativeQueue"][number], i: number) => (
        <div
          key={`${entry.name}-${i}`}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[0.65rem] font-semibold transition-all",
            i === 0 && !entry.hasActed
              ? "bg-amber-500/20 text-amber-300"
              : entry.hasActed
                ? "text-neutral-600 opacity-50 line-through"
                : entry.isPlayer
                  ? "text-blue-300"
                  : "text-red-300",
          )}
        >
          {entry.name}
          <span className="font-mono text-[0.55rem] opacity-60">{entry.initiativeResult}</span>
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────
// Skill cards + ActionPanel
// ──────────────────────────────────────────────

function HoshitoSkillCard({
  slotKey,
  action,
  disabled,
  isDefensiveStandby,
  onClick,
}: {
  slotKey: SlotKey;
  action: HoshitoDefaultActions[SlotKey];
  disabled: boolean;
  isDefensiveStandby?: boolean;
  onClick: () => void;
}) {
  const meta = SLOT_META[slotKey];
  const typeLabel = ACTION_TYPE_LABELS[action.type] ?? action.type;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col rounded-xl border p-3 text-left transition-all focus:outline-none flex-1 min-w-0",
        meta.borderClass,
        "bg-white/[0.02]",
        !disabled && `hover:bg-white/[0.06] hover:ring-1 ${meta.ringClass}`,
        disabled && "cursor-not-allowed opacity-40",
        isDefensiveStandby && `ring-1 ${meta.ringClass}`,
      )}
    >
      <div className={cn("mb-1.5 flex items-center gap-1 text-[0.575rem] font-bold uppercase tracking-widest", meta.headerClass)}>
        {meta.icon}
        {meta.label}
      </div>
      <span className="truncate text-sm font-bold leading-tight text-white/90">
        {action.name || "—"}
      </span>
      <span className="mt-1 text-[0.6rem] text-neutral-500">{typeLabel}</span>
      {isDefensiveStandby && (
        <span className="mt-1 text-[0.55rem] font-semibold uppercase tracking-wider text-teal-400/70">
          Standby
        </span>
      )}
    </button>
  );
}

function ActionPanel({
  defaultActions,
  phase,
  isWaiting,
  hasSpeedDice,
  onMelee,
  onRanged,
  onDefend,
  onMove,
  onManeuver,
  onFlee,
}: {
  defaultActions: HoshitoDefaultActions;
  phase: CombatPhase;
  isWaiting: boolean;
  hasSpeedDice: boolean;
  onMelee: () => void;
  onRanged: () => void;
  onDefend: () => void;
  onMove: () => void;
  onManeuver: () => void;
  onFlee: () => void;
}) {
  const canAct = phase === "player_turn" && !isWaiting;
  const isIncoming = phase === "incoming_attack";

  return (
    <div className="shrink-0 border-t border-white/[0.06] px-3 py-2 space-y-2">
      {/* Skill cards row */}
      <div className="flex gap-2">
        <HoshitoSkillCard
          slotKey="melee"
          action={defaultActions.melee}
          disabled={!canAct}
          onClick={onMelee}
        />
        <HoshitoSkillCard
          slotKey="ranged"
          action={defaultActions.ranged}
          disabled={!canAct}
          onClick={onRanged}
        />
        <HoshitoSkillCard
          slotKey="defensive"
          action={defaultActions.defensive}
          disabled={!isIncoming || !hasSpeedDice}
          isDefensiveStandby={isIncoming && hasSpeedDice}
          onClick={onDefend}
        />
      </div>
      {/* Utility row */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onMove}
          disabled={!canAct}
          className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-neutral-400 transition-colors hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowRight size={11} />
          Move
        </button>
        <button
          type="button"
          onClick={onManeuver}
          disabled={!canAct}
          className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-neutral-400 transition-colors hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Zap size={11} />
          Maneuver
        </button>
        <button
          type="button"
          onClick={onFlee}
          disabled={!canAct}
          className="ml-auto flex items-center gap-1 rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-1.5 text-xs font-semibold text-red-400/70 transition-colors hover:bg-red-950/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Flee
        </button>
        {isWaiting && (
          <span className="ml-auto text-[0.6rem] text-neutral-600 animate-pulse">
            Waiting for GM…
          </span>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Clash resolver
// ──────────────────────────────────────────────

function ClashDieFace({
  die,
  label,
  isWinner,
}: {
  die: HoshitoClashResult["attackerDie"] | NonNullable<HoshitoClashResult["defenderDie"]>;
  label: string;
  isWinner: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-1", isWinner && "opacity-100")}>
      <span className="text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-500">
        {label}
      </span>
      <div
        className={cn(
          "flex h-14 w-14 items-center justify-center rounded-xl border-2 font-mono text-xl font-bold transition-all",
          isWinner
            ? "border-teal-500 bg-teal-950/50 text-teal-300"
            : "border-red-800/60 bg-red-950/30 text-red-400",
        )}
      >
        {die.power}
      </div>
      <span className="text-[0.55rem] text-neutral-600">
        {die.dieType} +{die.modifier} · {die.role}
      </span>
    </div>
  );
}

function ClashResolverContent({
  clash,
  onCoinRetry,
  onConfirm,
}: {
  clash: HoshitoClashResult;
  onCoinRetry: () => void;
  onConfirm: () => void;
}) {
  const attackerWon = clash.outcome === "win" || clash.outcome === "unopposed";
  const isTie = clash.outcome === "tie";

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-center gap-2">
        <Swords size={14} className="text-orange-400" />
        <h3 className="text-sm font-bold uppercase tracking-widest text-white">
          {clash.defenderDie ? "Clash" : "Unopposed"}
        </h3>
      </div>

      {/* Die comparison */}
      <div className="flex items-center justify-center gap-4">
        <ClashDieFace
          die={clash.attackerDie}
          label="Attacker"
          isWinner={attackerWon}
        />
        {clash.defenderDie && (
          <>
            <span className="text-xs font-bold text-neutral-600">VS</span>
            <ClashDieFace
              die={clash.defenderDie}
              label="Defender"
              isWinner={!attackerWon && !isTie}
            />
          </>
        )}
      </div>

      {/* Outcome */}
      <div
        className={cn(
          "rounded-lg border px-3 py-2 text-center text-xs font-bold",
          attackerWon
            ? "border-red-800/50 bg-red-950/30 text-red-300"
            : isTie
              ? "border-neutral-700 bg-neutral-900/50 text-neutral-400"
              : "border-teal-800/50 bg-teal-950/30 text-teal-300",
        )}
      >
        {attackerWon && !isTie && (
          <>
            Attacker wins · −{clash.healthDamage} HP · −{clash.staggerDamage} SGR
          </>
        )}
        {!attackerWon && !isTie && "Defender wins · Attack blocked"}
        {isTie && "Tie — no damage dealt"}
      </div>

      {/* Morale change */}
      {(clash.moraleChange.attacker !== 0 || clash.moraleChange.defender !== 0) && (
        <div className="flex justify-center gap-3 text-[0.6rem]">
          <span className={clash.moraleChange.attacker >= 0 ? "text-teal-400" : "text-red-400"}>
            Attacker MRL {clash.moraleChange.attacker >= 0 ? "+" : ""}{clash.moraleChange.attacker}
          </span>
          <span className={clash.moraleChange.defender >= 0 ? "text-teal-400" : "text-red-400"}>
            Defender MRL {clash.moraleChange.defender >= 0 ? "+" : ""}{clash.moraleChange.defender}
          </span>
        </div>
      )}

      {/* Coin retry */}
      {clash.coinRetryAvailable && !clash.wasRetried && (
        <button
          type="button"
          onClick={onCoinRetry}
          className="w-full rounded-lg border border-amber-700/50 bg-amber-950/40 py-2 text-xs font-bold text-amber-300 transition-colors hover:bg-amber-950/60"
        >
          <Coins size={11} className="inline mr-1" />
          Spend Coin to Retry
          {clash.coinBonus ? ` (+${clash.coinBonus})` : ""}
        </button>
      )}
      {clash.wasRetried && (
        <p className="text-center text-[0.6rem] text-amber-400/70">
          Coin spent · Retry Power {clash.retriedPower ?? "—"}
        </p>
      )}

      {/* Continue */}
      <button
        type="button"
        onClick={onConfirm}
        className="w-full rounded-lg bg-white/10 py-2 text-xs font-bold text-white transition-colors hover:bg-white/15"
      >
        Continue
      </button>
    </div>
  );
}

function ClashResolver({
  clash,
  mode,
  onCoinRetry,
  onConfirm,
}: {
  clash: HoshitoClashResult;
  mode: ClashMode;
  onCoinRetry: () => void;
  onConfirm: () => void;
}) {
  if (mode === "focused") {
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div
          className={cn(
            NEUTRAL_SURFACE_VARIABLES,
            "w-full max-w-xs rounded-2xl border border-white/[0.09] bg-[var(--marinara-chat-chrome-panel-bg)] p-5 shadow-2xl",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <ClashResolverContent
            clash={clash}
            onCoinRetry={onCoinRetry}
            onConfirm={onConfirm}
          />
        </div>
      </div>,
      document.body,
    );
  }

  // Inline mode
  return (
    <div className="shrink-0 border-t border-white/[0.06] bg-white/[0.02] px-4 py-3">
      <ClashResolverContent
        clash={clash}
        onCoinRetry={onCoinRetry}
        onConfirm={onConfirm}
      />
    </div>
  );
}

// ──────────────────────────────────────────────
// Incoming attack prompt
// ──────────────────────────────────────────────

function IncomingAttackPrompt({
  attack,
  hasSpeedDice,
  defensiveActionName,
  onSpend,
  onTakeIt,
}: {
  attack: PendingIncomingAttack;
  hasSpeedDice: boolean;
  defensiveActionName: string;
  onSpend: () => void;
  onTakeIt: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-red-900/40 bg-red-950/20 px-4 py-3">
      <p className="mb-2 text-xs font-bold text-red-300">
        ⚔ {attack.attackerName} is attacking! (Power {attack.attackerPower})
      </p>
      <p className="mb-3 text-[0.65rem] text-neutral-400">
        Potential: −{attack.healthDamage} HP · −{attack.staggerDamage} SGR
      </p>
      <div className="flex gap-2">
        {hasSpeedDice ? (
          <button
            type="button"
            onClick={onSpend}
            className="flex-1 rounded-lg border border-teal-700/50 bg-teal-950/40 py-2 text-xs font-bold text-teal-300 transition-colors hover:bg-teal-950/60"
          >
            <Shield size={11} className="inline mr-1" />
            Spend Speed Die → {defensiveActionName}
          </button>
        ) : (
          <div className="flex-1 rounded-lg border border-white/[0.06] bg-white/[0.02] py-2 text-center text-xs text-neutral-600">
            No Speed Dice remaining
          </div>
        )}
        <button
          type="button"
          onClick={onTakeIt}
          className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] py-2 text-xs font-semibold text-neutral-400 transition-colors hover:bg-white/[0.07]"
        >
          Take it (Unopposed)
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Combat log
// ──────────────────────────────────────────────

function CombatLog({ entries, narration }: { entries: CombatLogEntry[]; narration?: string }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  const logColorClass = (type: CombatLogEntry["type"]) => {
    switch (type) {
      case "clash": return "text-orange-300/80";
      case "morale": return "text-teal-300/80";
      case "stagger": return "text-blue-300/80";
      case "result": return "text-white/90";
      case "system": return "text-neutral-500";
      default: return "text-neutral-300/80";
    }
  };

  return (
    <div className="flex max-h-24 min-h-[3rem] flex-col overflow-y-auto rounded-lg border border-white/[0.05] bg-black/20 px-2 py-1.5 text-[0.65rem] leading-relaxed">
      {narration && entries.length === 0 && (
        <p className="text-neutral-400 italic">{narration}</p>
      )}
      {entries.map((e) => (
        <p key={e.id} className={logColorClass(e.type)}>
          {e.text}
        </p>
      ))}
      <div ref={endRef} />
    </div>
  );
}

// ──────────────────────────────────────────────
// Settings drawer
// ──────────────────────────────────────────────

function SettingsDrawer({
  clashMode,
  onClashModeChange,
  onClose,
}: {
  clashMode: ClashMode;
  onClashModeChange: (m: ClashMode) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute bottom-0 inset-x-0 z-30 rounded-t-2xl border-t border-white/[0.09] bg-[var(--marinara-chat-chrome-panel-bg)] p-4 shadow-2xl">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-bold text-white">Combat Settings</h3>
        <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200">
          <X size={14} />
        </button>
      </div>

      <div>
        <p className="mb-1.5 text-[0.6rem] font-semibold uppercase tracking-wider text-neutral-500">
          Clash Resolver Mode
        </p>
        <div className="flex gap-2">
          {(["focused", "inline"] as ClashMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onClashModeChange(m)}
              className={cn(
                "flex-1 rounded-lg border py-2 text-xs font-semibold capitalize transition-colors",
                clashMode === m
                  ? "border-white/25 bg-white/10 text-white"
                  : "border-white/[0.08] bg-white/[0.03] text-neutral-400 hover:text-white",
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[0.575rem] text-neutral-600">
          {clashMode === "focused"
            ? "Focused — full overlay, cinematic. Best for first-time players."
            : "Inline — clash resolves in-panel, no freeze. Best for fast play."}
        </p>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 8);
}

function playerCombatant(state: HoshitoCombatState): HoshitoCombatant | undefined {
  return state.party.find((c: HoshitoCombatant) => c.isPlayer) ?? state.party[0];
}

// ──────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────

export function GameHoshitoCombatUI({
  initialCombatState,
  defaultActions,
  onPlayerAction,
  onCombatEnd,
  narration,
  combatControlsSlot,
}: GameHoshitoCombatUIProps) {
  const [combatState, setCombatState] = useState<HoshitoCombatState>(initialCombatState);
  const [phase, setPhase] = useState<CombatPhase>("player_turn");
  const [clashMode, setClashMode] = useState<ClashMode>("focused");
  const [pendingClash, setPendingClash] = useState<HoshitoClashResult | null>(null);
  const [incomingAttack, setIncomingAttack] = useState<PendingIncomingAttack | null>(null);
  const [log, setLog] = useState<CombatLogEntry[]>([]);
  const [isWaiting, setIsWaiting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [targetIndex, setTargetIndex] = useState(0);

  const addLog = useCallback((text: string, type: CombatLogEntry["type"] = "action") => {
    setLog((prev) => [...prev, { id: uid(), text, type }]);
  }, []);

  // Apply clash damage to local state
  const applyClashResult = useCallback(
    (clash: HoshitoClashResult, updatedState?: HoshitoCombatState) => {
      if (updatedState) {
        setCombatState(updatedState);
        return;
      }
      // Fallback: apply locally for Segment 3 demo
      setCombatState((prev: HoshitoCombatState) => {
        const next = structuredClone(prev);
        if (clash.outcome === "win" || clash.outcome === "unopposed") {
          const enemy = next.enemies[targetIndex];
          if (enemy) {
            enemy.health = Math.max(0, enemy.health - clash.healthDamage);
            enemy.stagger = Math.max(0, enemy.stagger - clash.staggerDamage);
            enemy.isStaggered = enemy.stagger <= 0;
            enemy.morale = Math.max(-45, enemy.morale + clash.moraleChange.defender);
          }
          const player = playerCombatant(next);
          if (player) {
            player.morale = Math.min(45, player.morale + clash.moraleChange.attacker);
          }
        } else if (clash.outcome === "lose") {
          const player = playerCombatant(next);
          if (player) {
            player.health = Math.max(0, player.health - clash.healthDamage);
            player.stagger = Math.max(0, player.stagger - clash.staggerDamage);
            player.isStaggered = player.stagger <= 0;
            player.morale = Math.max(-45, player.morale + clash.moraleChange.defender);
          }
        }
        return next;
      });
    },
    [targetIndex],
  );

  // Player takes an offensive action
  const handleOffensiveAction = useCallback(
    async (slotKey: "melee" | "ranged") => {
      if (phase !== "player_turn" || isWaiting) return;
      setIsWaiting(true);
      setPhase("awaiting_result");

      const action: HoshitoPlayerAction = {
        type: "attack",
        description: defaultActions[slotKey].name,
        target: combatState.enemies[targetIndex]?.name,
        dieRole: "offensive",
      };

      addLog(`You use ${defaultActions[slotKey].name} (${ACTION_TYPE_LABELS[defaultActions[slotKey].type] ?? defaultActions[slotKey].type}).`, "action");

      try {
        const result = await onPlayerAction(action, combatState);
        if (result.updatedState) setCombatState(result.updatedState);
        if (result.narrative) addLog(result.narrative, "result");

        if (result.clashResult) {
          setPendingClash(result.clashResult);
          setPhase("clash_display");
        } else {
          setPhase("player_turn");
        }

        if (result.updatedState?.combatEnd) {
          const { result: outcome, narrative: endNarr } = result.updatedState.combatEnd;
          addLog(endNarr, "system");
          setPhase(outcome === "victory" ? "victory" : "defeat");
          setTimeout(() => onCombatEnd(outcome as "victory" | "defeat" | "fled", endNarr), 1500);
        }
      } catch {
        addLog("Action failed — try again.", "system");
        setPhase("player_turn");
      } finally {
        setIsWaiting(false);
      }
    },
    [phase, isWaiting, defaultActions, combatState.enemies, targetIndex, addLog, onPlayerAction, onCombatEnd],
  );

  // Defensive response to incoming attack
  const handleDefendResponse = useCallback(() => {
    if (!incomingAttack) return;
    const player = playerCombatant(combatState);
    if (!player || player.speedDice.remaining <= 0) return;

    // Spend the Speed Die locally (Segment 4 will drive this from server)
    setCombatState((prev: HoshitoCombatState) => {
      const next = structuredClone(prev);
      const p = next.party.find((c: HoshitoCombatant) => c.isPlayer) ?? next.party[0];
      if (p) p.speedDice.remaining = Math.max(0, p.speedDice.remaining - 1);
      return next;
    });

    // Build a local clash for demo
    const defensePower = Math.floor(Math.random() * 8) + 1;
    const attackerWins = incomingAttack.attackerPower > defensePower;

    const mockClash: HoshitoClashResult = {
      attackerDie: {
        role: "offensive",
        dieType: "d8",
        rolled: incomingAttack.attackerPower,
        modifier: 0,
        power: incomingAttack.attackerPower,
      },
      defenderDie: {
        role: defaultActions.defensive.type === "Evade" ? "evade" : defaultActions.defensive.type === "PowerGuard" ? "power_guard" : "guard",
        dieType: "d8",
        rolled: defensePower,
        modifier: 0,
        power: defensePower,
      },
      outcome: attackerWins ? "lose" : "win",
      healthDamage: attackerWins ? incomingAttack.healthDamage : 0,
      staggerDamage: attackerWins ? incomingAttack.staggerDamage : 0,
      moraleChange: {
        attacker: attackerWins ? 3 : -3,
        defender: attackerWins ? -3 : 3,
      },
      coinRetryAvailable: attackerWins,
      wasRetried: false,
    };

    addLog(
      `${incomingAttack.attackerName} attacks! You respond with ${defaultActions.defensive.name}.`,
      "clash",
    );
    setIncomingAttack(null);
    setPendingClash(mockClash);
    setPhase("clash_display");
  }, [incomingAttack, combatState, defaultActions.defensive, addLog]);

  const handleTakeHit = useCallback(() => {
    if (!incomingAttack) return;
    addLog(
      `${incomingAttack.attackerName} hits unopposed! −${incomingAttack.healthDamage} HP · −${incomingAttack.staggerDamage} SGR`,
      "result",
    );
    setCombatState((prev: HoshitoCombatState) => {
      const next = structuredClone(prev);
      const p = next.party.find((c: HoshitoCombatant) => c.isPlayer) ?? next.party[0];
      if (p) {
        p.health = Math.max(0, p.health - incomingAttack.healthDamage);
        p.stagger = Math.max(0, p.stagger - incomingAttack.staggerDamage);
        p.isStaggered = p.stagger <= 0;
      }
      return next;
    });
    setIncomingAttack(null);
    setPhase("player_turn");
  }, [incomingAttack, addLog]);

  const handleClashConfirm = useCallback(() => {
    if (!pendingClash) return;
    applyClashResult(pendingClash);
    addLog(
      pendingClash.outcome === "win"
        ? `Hit! −${pendingClash.healthDamage} HP · −${pendingClash.staggerDamage} SGR`
        : pendingClash.outcome === "lose"
          ? `Blocked! Enemy wins the Clash.`
          : "Tie — no damage.",
      "result",
    );
    setPendingClash(null);
    setPhase("player_turn");
  }, [pendingClash, applyClashResult, addLog]);

  const handleCoinRetry = useCallback(() => {
    if (!pendingClash || pendingClash.wasRetried) return;
    const player = playerCombatant(combatState);
    if (!player || player.coins <= 0) return;

    setCombatState((prev: HoshitoCombatState) => {
      const next = structuredClone(prev);
      const p = next.party.find((c: HoshitoCombatant) => c.isPlayer) ?? next.party[0];
      if (p) p.coins = Math.max(0, p.coins - 1);
      return next;
    });

    const bonus = player.coinBonus || 0;
    const retriedPower = pendingClash.defenderDie ? pendingClash.defenderDie.power + bonus : 0;
    const attackerStillWins = pendingClash.attackerDie.power > retriedPower;

    setPendingClash((prev: HoshitoClashResult | null) =>
      prev
        ? {
            ...prev,
            outcome: attackerStillWins ? "lose" : "win",
            wasRetried: true,
            coinBonus: bonus,
            retriedPower,
            healthDamage: attackerStillWins ? prev.healthDamage : 0,
            staggerDamage: attackerStillWins ? prev.staggerDamage : 0,
          }
        : null,
    );
    addLog(`Coin spent! Retry Power: ${retriedPower}`, "clash");
  }, [pendingClash, combatState, addLog]);

  const handleMove = useCallback(async () => {
    if (phase !== "player_turn" || isWaiting) return;
    addLog("You move to a new position. (1 AP)", "action");
    const result = await onPlayerAction({ type: "movement", description: "Move" }, combatState);
    if (result.updatedState) setCombatState(result.updatedState);
    if (result.narrative) addLog(result.narrative, "result");
  }, [phase, isWaiting, addLog, onPlayerAction, combatState]);

  const handleManeuver = useCallback(async () => {
    if (phase !== "player_turn" || isWaiting) return;
    addLog("You maneuver. (1 AP)", "action");
    const result = await onPlayerAction({ type: "maneuver", description: "Maneuver" }, combatState);
    if (result.updatedState) setCombatState(result.updatedState);
    if (result.narrative) addLog(result.narrative, "result");
  }, [phase, isWaiting, addLog, onPlayerAction, combatState]);

  const handleFlee = useCallback(() => {
    addLog("You flee the battle.", "system");
    onCombatEnd("fled", "The party fled from combat.");
  }, [addLog, onCombatEnd]);

  const player = playerCombatant(combatState);
  const hasSpeedDice = (player?.speedDice.remaining ?? 0) > 0;
  const showClashResolver = phase === "clash_display" && pendingClash;

  return (
    <div
      className={cn(
        NEUTRAL_SURFACE_VARIABLES,
        "relative flex h-full flex-col overflow-hidden bg-[var(--marinara-chat-chrome-panel-bg)]",
      )}
    >
      {/* Initiative queue */}
      <InitiativeQueueBar queue={combatState.initiativeQueue} round={combatState.round} />

      {/* Header controls row */}
      <div className="flex items-center justify-between border-b border-white/[0.05] px-3 py-1 shrink-0">
        <p className="text-[0.6rem] text-neutral-600 truncate">
          {combatState.environment}
        </p>
        <div className="flex items-center gap-1">
          {combatControlsSlot}
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="rounded-lg p-1.5 text-neutral-600 hover:text-neutral-300 transition-colors"
            title="Combat settings"
          >
            <Settings size={13} />
          </button>
        </div>
      </div>

      {/* Main combat field */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {/* Enemies */}
        {combatState.enemies.length > 0 && (
          <div className="flex flex-wrap justify-center gap-3">
            {combatState.enemies.map((enemy: HoshitoCombatant, i: number) => (
              <CombatantCard
                key={enemy.name}
                combatant={enemy}
                isActive={combatState.initiativeQueue[0]?.name === enemy.name}
                targetable={phase === "player_turn" && !isWaiting}
                onTarget={() => setTargetIndex(i)}
              />
            ))}
          </div>
        )}

        {/* Target selector if multiple enemies */}
        {combatState.enemies.length > 1 && phase === "player_turn" && (
          <div className="flex items-center justify-center gap-2">
            <span className="text-[0.6rem] text-neutral-600">Target:</span>
            <div className="flex gap-1">
              {combatState.enemies.map((e: HoshitoCombatant, i: number) => (
                <button
                  key={e.name}
                  type="button"
                  onClick={() => setTargetIndex(i)}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-[0.6rem] font-semibold transition-colors",
                    i === targetIndex
                      ? "border-red-600 bg-red-950/50 text-red-300"
                      : "border-white/[0.08] text-neutral-500 hover:text-neutral-300",
                  )}
                >
                  {e.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Combat log */}
        <CombatLog entries={log} narration={narration} />

        {/* Party */}
        {combatState.party.length > 0 && (
          <div className="flex flex-wrap justify-center gap-3">
            {combatState.party.map((member: HoshitoCombatant) => (
              <CombatantCard
                key={member.name}
                combatant={member}
                isActive={combatState.initiativeQueue[0]?.name === member.name}
              />
            ))}
          </div>
        )}
      </div>

      {/* Incoming attack prompt */}
      {incomingAttack && phase === "incoming_attack" && (
        <IncomingAttackPrompt
          attack={incomingAttack}
          hasSpeedDice={hasSpeedDice}
          defensiveActionName={defaultActions.defensive.name}
          onSpend={handleDefendResponse}
          onTakeIt={handleTakeHit}
        />
      )}

      {/* Inline clash resolver */}
      {showClashResolver && clashMode === "inline" && (
        <ClashResolver
          clash={pendingClash}
          mode="inline"
          onCoinRetry={handleCoinRetry}
          onConfirm={handleClashConfirm}
        />
      )}

      {/* Action panel */}
      <ActionPanel
        defaultActions={defaultActions}
        phase={phase}
        isWaiting={isWaiting}
        hasSpeedDice={hasSpeedDice}
        onMelee={() => handleOffensiveAction("melee")}
        onRanged={() => handleOffensiveAction("ranged")}
        onDefend={handleDefendResponse}
        onMove={handleMove}
        onManeuver={handleManeuver}
        onFlee={handleFlee}
      />

      {/* Focused clash resolver (portal) */}
      {showClashResolver && clashMode === "focused" && (
        <ClashResolver
          clash={pendingClash}
          mode="focused"
          onCoinRetry={handleCoinRetry}
          onConfirm={handleClashConfirm}
        />
      )}

      {/* Settings drawer */}
      {showSettings && (
        <SettingsDrawer
          clashMode={clashMode}
          onClashModeChange={setClashMode}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* End states */}
      {(phase === "victory" || phase === "defeat") && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="text-center">
            <p
              className={cn(
                "text-2xl font-bold",
                phase === "victory" ? "text-teal-300" : "text-red-400",
              )}
            >
              {phase === "victory" ? "Victory" : "Defeat"}
            </p>
            <p className="mt-1 text-xs text-neutral-400">
              {phase === "victory" ? "The battle is won." : "The battle is lost."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
