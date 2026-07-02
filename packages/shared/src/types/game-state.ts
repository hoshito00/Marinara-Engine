// ──────────────────────────────────────────────
// Game State Types (RPG Companion replacement)
// ──────────────────────────────────────────────

/** Complete game state snapshot, linked to a message. */
export type TrackerFieldLocks = Record<string, boolean>;

export interface GameState {
  id: string;
  chatId: string;
  messageId: string;
  /** Swipe index this state corresponds to */
  swipeIndex: number;

  // ── Scene ──
  date: string | null;
  time: string | null;
  location: string | null;
  weather: string | null;
  temperature: string | null;

  // ── Characters ──
  presentCharacters: PresentCharacter[];

  // ── Events ──
  recentEvents: string[];

  // ── Player ──
  playerStats: PlayerStats | null;

  // ── Persona ──
  /** Persona status bars (Satiety, Energy, etc.) — tracked by persona-stats agent */
  personaStats: CharacterStat[] | null;

  /** Whether this snapshot has been committed (user sent a follow-up message). */
  committed?: boolean;

  /** JSON object of manually-edited field names → values. Carried forward across agent snapshots. */
  manualOverrides?: Record<string, string> | null;

  /** JSON object of tracker field lock keys → enabled. Carried forward across agent snapshots. */
  fieldLocks?: TrackerFieldLocks | null;

  createdAt: string;
}

/** A character present in the current scene. */
export interface PresentCharacter {
  characterId: string;
  name: string;
  emoji: string;
  mood: string;
  /** @deprecated No longer tracked — kept for backward compat */
  action?: string;
  /** Brief physical appearance description */
  appearance: string | null;
  /** Current clothing / outfit description */
  outfit: string | null;
  /** Avatar image path (e.g., /api/avatars/file/<filename>) */
  avatarPath?: string | null;
  /** Optional avatar crop JSON carried from the character card. */
  avatarCrop?: unknown;
  /** Featured tracker portrait focus, 0 = left, 100 = right. */
  portraitFocusX?: number;
  /** Featured tracker portrait focus, 0 = top, 100 = bottom; expression sprites may exceed 100 to dip below the frame. */
  portraitFocusY?: number;
  /** Featured tracker portrait zoom multiplier. */
  portraitZoom?: number;
  /** Per-character custom fields */
  customFields: Record<string, string>;
  /** Per-character stats (HP, etc.) */
  stats: CharacterStat[];
  /** What the character is thinking */
  thoughts: string | null;
  /**
   * Hoshito ruleset live counters (Verve, Story Points) for this party member.
   * Tier B — the only Hoshito data that is versioned per message/swipe and carried
   * forward / rolled back with the rest of game state. The character's full sheet
   * (Domains, Grades, Merits, etc.) lives in chatMeta.gameCharacterCards[].hoshitoStats
   * instead, since it is not meant to fork/rewind like a live counter.
   */
  hoshitoCounters?: HoshitoCounters | null;
}

/**
 * Hoshito ruleset live counters — the only part of a Hoshito sheet that is a genuine
 * earned/spent counter needing snapshot-cloning/carry-forward treatment across turns.
 * Everything else about a character's Hoshito sheet (Domains, Merits, Strand, etc.) is
 * chat-scoped "build" data, not a per-message counter — see HoshitoCharacterStats.
 */
export interface HoshitoCounters {
  verve: number;
  storyPoints: number;
}

/** A numeric stat for a character. */
export interface CharacterStat {
  name: string;
  value: number;
  max: number;
  color: string;
}

/** A user-defined custom tracker field. */
export interface CustomTrackerField {
  name: string;
  value: string;
  /** @deprecated Use GameState.fieldLocks for persisted per-cell tracker locks. */
  locked?: boolean;
}

/** Player-specific stats and inventory. */
export interface PlayerStats {
  /** Custom stat bars */
  stats: CharacterStat[];
  /**
   * Hoshito ruleset character statistics.
   * Fully freeform — Domains, Attributes, Grades, Sparks, Merits, Strand.
   * Primary stats field for Hoshito sessions.
   */
  hoshitoStats?: HoshitoCharacterStats | null;
  /**
   * Hoshito ruleset live counters (Verve, Story Points) for the player.
   * Tier B — see PresentCharacter.hoshitoCounters for the full explanation. The
   * player's full sheet now lives in chatMeta.gameCharacterCards[].hoshitoStats;
   * this field (and the legacy hoshitoStats above) exist for backward-compat reads
   * of already-populated chats.
   */
  hoshitoCounters?: HoshitoCounters | null;
  /** @deprecated Use hoshitoStats. Classic D&D-style attributes — being phased out. */
  attributes: RPGAttributes | null;
  /** @deprecated Skills are not a distinct mechanic in Hoshito — use Attribute Grades and Sparks. */
  skills: Record<string, number>;
  /** Inventory items */
  inventory: InventoryItem[];
  /** Active quests */
  activeQuests: QuestProgress[];
  /** Status text */
  status: string;
  /** User-defined custom tracker fields */
  customTrackerFields?: CustomTrackerField[];
}

// ──────────────────────────────────────────────
// Hoshito Ruleset — Grade System
// ──────────────────────────────────────────────

/**
 * The full Grade scale for Hoshito's ruleset.
 * FFF (−5) through EX (+9) — 14 tiers.
 * Deficit grades (FFF–F−) actively impede. F is the baseline.
 * S–SSS are post-human. EX is mythic.
 */
export type HoshitoGrade =
  | "FFF"
  | "FF-"
  | "FF"
  | "F-"
  | "F"
  | "E"
  | "D"
  | "C"
  | "B"
  | "A"
  | "S"
  | "SS"
  | "SSS"
  | "EX";

/** Numerical modifier value for each Grade, used in roll formulas. */
export const HOSHITO_GRADE_VALUES: Record<HoshitoGrade, number> = {
  FFF: -5,
  "FF-": -4,
  FF: -3,
  "F-": -2,
  F: -1,
  E: 1,
  D: 2,
  C: 3,
  B: 4,
  A: 5,
  S: 6,
  SS: 7,
  SSS: 8,
  EX: 9,
};

/** Ordered list of all grades from lowest to highest. */
export const HOSHITO_GRADE_ORDER: HoshitoGrade[] = [
  "FFF", "FF-", "FF", "F-", "F",
  "E", "D", "C", "B", "A",
  "S", "SS", "SSS", "EX",
];

// ──────────────────────────────────────────────
// Hoshito Ruleset — Attribute & Domain Structure
// Fully freeform — no hardcoded attribute or domain names.
// The ruleset document specifies MIG/AGI/VIT etc., but the
// type system enforces no particular names.
// ──────────────────────────────────────────────

/**
 * A single Attribute within a Domain.
 * Name is freeform — defined by the player and ruleset, not by the type.
 */
export interface HoshitoAttribute {
  /** Freeform attribute name, e.g. "Might", "MIG", or anything the ruleset defines. */
  name: string;
  /** Current Grade. Defaults to "F" at character creation. */
  grade: HoshitoGrade;
  /**
   * Standard Sparks — each adds +1 to rolls using this Attribute.
   * Cap is normally 3, raised to 4 (or 5 after Strand Refinement) for Primary Attribute.
   * Consumed by rank-ups (one per rank-up if present).
   */
  sparks: number;
  /**
   * Vestige Sparks — permanent Sparks from Core Merit transformation.
   * Structurally identical to standard Sparks (+1 to rolls, count toward Domain Sparks)
   * but immune to removal on rank-up. Displayed distinctly on the sheet.
   */
  vestigeSparks: number;
  /**
   * Whether this Attribute has been Exalted (reset to F+ after reaching max level).
   * Only applies post-Exaltation.
   */
  isExalted?: boolean;
  /**
   * How many times this Attribute's Domain has been Exalted.
   * 1 = "+", 2 = "++" on the character sheet.
   */
  exaltCount?: number;
}

/**
 * A Domain containing freeform Attributes.
 * Name is freeform — e.g. "Physical", "Mental", "Social", or any custom domain.
 */
export interface HoshitoDomain {
  /** Freeform domain name. */
  name: string;
  /** The Attributes within this Domain (typically 3, but not enforced). */
  attributes: HoshitoAttribute[];
}

/**
 * A character's Strand (self-defined path / class equivalent).
 * Declared at creation or before end of Level 3.
 */
export interface HoshitoStrand {
  name: string;
  description: string;
  /** The Attribute name designated as Primary (Spark cap raised from 3 → 4, or 5 after Refinement). */
  primaryAttribute: string;
  /** Ability Merits granted by the Strand (up to 3 before fork; LLM-discretion grants). */
  abilityMerits: string[];
  /** The guaranteed Culmination Merit granted at Level 13. */
  culminationMerit?: string;
  /** Fork choice taken at Level 14. */
  fork?: "refinement" | "new_strand";
  /** Second Strand name if fork = "new_strand". */
  secondStrandName?: string;
  /** Second Strand Primary Attribute if fork = "new_strand". */
  secondStrandPrimaryAttribute?: string;
}

/** A single Merit entry. */
export interface HoshitoMerit {
  /** Merit category — determines how it functions mechanically. */
  category: "feat" | "artifact" | "ability" | "augment" | "contact";
  /** Freeform name of the merit. */
  name: string;
  /** Narrative description — required; this is what the LLM draws on for transformations. */
  description: string;
  /**
   * Spark grant: which Attribute this Merit adds a Spark to (Feats, Artifacts, Augments).
   * Abilities grant no Spark; Contacts grant no Spark.
   */
  sparkGrantAttribute?: string;
  /** Whether this merit is currently dormant (acknowledged but not yet narratively active). */
  dormant?: boolean;
}

/** A Core Merit (Ancestry, Heritage, Background) and its transformation state. */
export interface HoshitoCoreMerit {
  type: "ancestry" | "heritage" | "background";
  description: string;
  /** Grade step granted at creation (applied to one chosen Attribute). */
  attributeGrant?: string;
  /** Whether the creation grant converted to a Spark instead (Attribute already at Grade D cap). */
  grantedSpark?: boolean;
  /** Transformations applied at milestone levels or narrative moments. */
  transformations: Array<{
    merit: HoshitoMerit;
    level: number;
    narrative: string;
  }>;
  /**
   * Innate Resistance Merit — Ancestry type only.
   * Granted at Core Merit transformation windows (Level 7, 14, 21, or 26).
   * Carries a mandatory Fatal vulnerability alongside the resistance grants.
   */
  innateResistance?: HoshitoInnateResistanceMerit;
}

// ──────────────────────────────────────────────
// Resistance System
// ──────────────────────────────────────────────

/** The six damage types. Physical: Slash / Pierce / Blunt. Magic: Spectral / Elemental / Empyreal. */
export type HoshitoDamageType =
  | "Slash" | "Pierce" | "Blunt"           // Physical
  | "Spectral" | "Elemental" | "Empyreal"; // Magic

/**
 * Resistance tier ladder (exact Limbus Company).
 * Applied to Power after Clash resolution, before damage is dealt. Round down.
 * Default for all unspecified entries = Normal ×1. Only non-Normal entries are stored.
 */
export type HoshitoResistanceTier =
  | "Fatal"       // ×2
  | "Weak"        // ×1.5
  | "Normal"      // ×1  (default — omit from stored data)
  | "Endured"     // ×0.5
  | "Ineffective" // ×0.25
  | "Immune";     // ×0

export const HOSHITO_RESISTANCE_MULTIPLIERS: Record<HoshitoResistanceTier, number> = {
  Fatal:       2,
  Weak:        1.5,
  Normal:      1,
  Endured:     0.5,
  Ineffective: 0.25,
  Immune:      0,
};

/**
 * One resistance entry for a combatant.
 * Health and Stagger resistance are tracked separately per damage type.
 * e.g. Slash: Health = Endured, Stagger = Fatal → hard to cut down but easy to overwhelm.
 */
export interface HoshitoResistanceEntry {
  type: HoshitoDamageType;
  /** Resistance tier applied to Health damage of this type. */
  healthTier:  HoshitoResistanceTier;
  /** Resistance tier applied to Stagger damage of this type. */
  staggerTier: HoshitoResistanceTier;
}

/** Resistance profile for a combatant. Only non-Normal entries need to be stored. */
export type HoshitoResistanceProfile = HoshitoResistanceEntry[];

/**
 * Innate Resistance Merit — passive, Ancestry-rooted.
 * Granted at Core Merit transformation windows (Level 7, 14, 21, 26).
 * Every instance MUST carry a mandatory Fatal vulnerability on either Health or Stagger.
 * Resistance always comes with a crack.
 */
export interface HoshitoInnateResistanceMerit {
  /** Which transformation window granted this. */
  grantedAt: 7 | 14 | 21 | 26 | "narrative";
  healthResistance:  { type: HoshitoDamageType; tier: HoshitoResistanceTier };
  staggerResistance: { type: HoshitoDamageType; tier: HoshitoResistanceTier };
  /** The mandatory vulnerability granted alongside this merit. */
  vulnerability: {
    type: HoshitoDamageType;
    affectedStat: "health" | "stagger";
    tier: "Fatal";
  };
  /** Ancestry narrative text explaining why this resistance exists (bloodline / lineage). */
  ancestryNarrative: string;
}

/**
 * Maps the derived stat formula slots to freeform attribute names.
 * Defaults to standard Hoshito names when absent.
 * Allows fully custom domain/attribute layouts.
 */
export interface HoshitoDerivedStatConfig {
  /** Attribute name used for Health formula slot 1. Default: "MIG" */
  healthAttr1: string;
  /** Attribute name used for Health formula slot 2. Default: "WIL" */
  healthAttr2: string;
  /** Attribute name used for Stagger formula slot 1. Default: "VIT" */
  staggerAttr1: string;
  /** Attribute name used for Stagger formula slot 2. Default: "INT" */
  staggerAttr2: string;
  /** Attribute name used for AP formula. Default: "PSY" */
  apAttr: string;
}

export const DEFAULT_DERIVED_STAT_CONFIG: HoshitoDerivedStatConfig = {
  healthAttr1:  "MIG",
  healthAttr2:  "WIL",
  staggerAttr1: "VIT",
  staggerAttr2: "INT",
  apAttr:       "PSY",
};

/**
 * Full Hoshito character statistics.
 * Replaces RPGAttributes. Fully freeform — no attribute names are hardcoded.
 */
export interface HoshitoCharacterStats {
  /** Whether Hoshito tracking is active for this session. Undefined/true = active. False = hidden but data preserved — toggling back on does not require re-entry. */
  enabled?: boolean;
  level: number;
  /** Freeform Domains. Typically 3 (Physical / Mental / Social) but not enforced by the type. */
  domains: HoshitoDomain[];
  /** The character's Strand (path / class equivalent). */
  strand?: HoshitoStrand;
  /** The three Core Merits (Ancestry, Heritage, Background). */
  coreMerits?: HoshitoCoreMerit[];
  /** All other Merits accumulated through play. */
  merits?: HoshitoMerit[];
  /** Magic alignment — soul property, set at creation, never changes without divine intervention. */
  magicAlignment?: "spectral" | "elemental" | "empyreal";
  /** Magic subcategory school (can differ from alignment's default — creates the Resolving Arc). */
  magicSubcategory?: string;
  /**
   * Current Verve pool.
   * Cap = Level 1: 1. Level 2+: floor(Level / 2).
   * Spending adds extra d20s to a roll (summed, not take-highest).
   */
  verve: number;
  /** Uncapped pool of Story Points. Spend 1 for automatic success on narrative/social checks. */
  storyPoints: number;
  /**
   * Voluntary Deficit flag.
   * If true, one Attribute is at F− by choice — grants 1 free Spark.
   * Max one deficit per character.
   */
  voluntaryDeficit?: boolean;
  /** The Attribute name affected by Voluntary Deficit (if active). */
  voluntaryDeficitAttribute?: string;
  // ── Combat-derived stats (calculated from Attributes; stored for display) ──
  /** Health = 25 + ((MIG + WIL) × 5). Calculated; stored here for convenience. */
  healthMax?: number;
  /** Current Health. */
  health?: number;
  /** Stagger = 15 + ((VIT + INT) × 5). Calculated; stored here for convenience. */
  staggerMax?: number;
  /** Current Stagger. */
  stagger?: number;
  /** AP = 3 + floor(PSY Grade Value / 3). Calculated. */
  apMax?: number;
  /** Starting Coins per combat = 3. */
  coins?: number;
  // ── Default Combat Actions (Limbus-style named skill cards) ──
  /**
   * The three customizable default combat action slots.
   * Set during Character Creation or Long Rest.
   * Slot 1 = Melee Offensive, Slot 2 = Ranged Offensive, Slot 3 = Defensive.
   */
  defaultActions?: HoshitoDefaultActions;
  /**
   * Persistent library of previously-used action names.
   * Populated on use in combat. Surfaced as reusable tags in the action editor.
   */
  actionNameLibrary?: string[];
  /**
   * Maps derived stat formula slots to the freeform attribute names used by this character.
   * Falls back to DEFAULT_DERIVED_STAT_CONFIG (MIG/WIL/VIT/INT/PSY) when absent.
   */
  derivedStatConfig?: HoshitoDerivedStatConfig;
  /**
   * Non-Normal resistance entries for this character.
   * Applied to Power after Clash resolution, before damage is dealt (round down).
   * Only non-Normal entries are stored; all unspecified types default to Normal ×1.
   */
  resistances?: HoshitoResistanceProfile;
  /**
   * Whether this character has undergone Exaltation (post Level 26 domain reset).
   * Enables F+ attribute markers on the sheet and raises the level cap to 52.
   */
  isExalted?: boolean;
}

// ──────────────────────────────────────────────
// Hoshito Default Actions (Limbus-style named skill cards)
// ──────────────────────────────────────────────

/** Action types available for Slot 1 (Melee Offensive). */
export type HoshitoMeleeActionType = "HMW" | "LMW" | "MeleeCantrip" | "Unarmed";

/** Action types available for Slot 2 (Ranged Offensive). */
export type HoshitoRangedActionType = "Marksmanship" | "SpellCantrip";

/** Action types available for Slot 3 (Defensive). */
export type HoshitoDefensiveActionType = "Evade" | "Guard" | "PowerGuard";

/** Union of all default action types across all slots. */
export type HoshitoDefaultActionType =
  | HoshitoMeleeActionType
  | HoshitoRangedActionType
  | HoshitoDefensiveActionType;

/** A single named default action slot. */
export interface HoshitoDefaultAction {
  /** Custom name given by the player — displayed on the combat skill card. */
  name: string;
  /** The mechanical action type this slot resolves as. */
  type: HoshitoDefaultActionType;
}

/**
 * The three default action slots for a character.
 * All three slots are always present; none can be empty.
 */
export interface HoshitoDefaultActions {
  /** Slot 1 — Melee Offensive: HMW / LMW / MeleeCantrip */
  melee: HoshitoDefaultAction;
  /** Slot 2 — Ranged Offensive: Marksmanship / SpellCantrip */
  ranged: HoshitoDefaultAction;
  /** Slot 3 — Defensive: Evade / Guard / PowerGuard */
  defensive: HoshitoDefaultAction;
}

/** Sensible defaults for a fresh character who hasn't customized their actions yet. */
export const HOSHITO_DEFAULT_ACTIONS: HoshitoDefaultActions = {
  melee:     { name: "Melee Attack",   type: "LMW" },
  ranged:    { name: "Ranged Attack",  type: "Marksmanship" },
  defensive: { name: "Evade",          type: "Evade" },
};

// ──────────────────────────────────────────────
// Legacy — to be removed when server-side
// skill-check.service.ts, perception.service.ts,
// game-gm-prompt-runtime.ts, and GameSurface.tsx
// are updated in Segment 4.
// ──────────────────────────────────────────────

/** @deprecated Use HoshitoCharacterStats instead. Classic D&D-style attributes — being phased out. */
export interface RPGAttributes {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

/** An item in the player's inventory. */
export interface InventoryItem {
  name: string;
  description: string;
  quantity: number;
  /** Location: "on_person" | "stored" | custom */
  location: string;
}

/** Quest progress data tracked in game state. */
export interface QuestProgress {
  questEntryId: string;
  name: string;
  currentStage: number;
  objectives: Array<{ text: string; completed: boolean }>;
  completed: boolean;
}
