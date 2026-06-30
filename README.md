# 🍝 Marinara Engine

> **This is a fork** — [hoshito00/Hositos-Marinara-Engine](https://github.com/hoshito00/Hositos-Marinara-Engine) — built on top of [Pasta-Devs/Marinara-Engine](https://github.com/Pasta-Devs/Marinara-Engine) with the **Hoshito Simplified TTRPG Ruleset** layered on top of Game Mode. Everything from the original engine still works; this fork just makes Game Mode actually play a Limbus Company styled TTRPG. See [RULESET.md](#RULESET.md) below.

<h3 align="center"><b>Fun. Intuitive. Plug-And-Play.</b></h3>

<p align="center">
  <b>A local, AI-powered chat, roleplay, and game engine</b> built around one idea: <b>you install it, you run it, and it just works. Oh, and don't forget about the part where you have fun! ALSO, HEY, LOOK, IT'S FREE.</b><br/>
  Created with agentic use in mind, allowing multiple requests at once. Everything is connected. Chat with your characters OOC about your roleplays. Have them create RP scenes for you. All designed with simplicity in mind: we don't want to spend hours on setup, we just want to <s>goon</s> play.<br/>
</p>

---

> **⚠️ Alpha Software** — Early release. Expect rough edges, missing features, and breaking changes. Bug reports and feedback are very welcome!

---

## Table of Contents

- [🍝 Marinara Engine](#-marinara-engine)
  - [Table of Contents](#table-of-contents)
  - [Latest Release](#latest-release)
  - [Roadmap](#roadmap)
  - [Installation](#installation)
  - [Features](#features)
    - [Chat \& Roleplay](#chat--roleplay)
    - [Visual \& Immersive](#visual--immersive)
    - [AI Agent System](#ai-agent-system)
    - [Prompt Engineering](#prompt-engineering)
    - [Connections \& Providers](#connections--providers)
    - [Export \& Data](#export--data)
  - [Hoshito TTRPG System](#hoshito-ttrpg-system)
    - [Domains \& Attributes](#domains--attributes)
    - [Grades \& Sparks](#grades--sparks)
    - [Strands](#strands)
    - [Merits \& Core Merits](#merits--core-merits)
    - [Combat](#combat)
    - [Resistance System](#resistance-system)
    - [Exaltation](#exaltation)
  - [Documentation](#documentation)
  - [Community \& Support](#community--support)
  - [Contributors](#contributors)
  - [License](#license)

---

<a id="screenshots"></a>

<details>
<summary><h2>Screenshots</h2></summary>

<p align="center">
  <img src="docs/screenshots/Desktop_Roleplay_View.png" width="90%" alt="Roleplay Chat — Desktop" />
  <br/>
  <em>Roleplay Mode — Character sprites, custom backgrounds, weather effects, and AI agents</em>
</p>

<p align="center">
  <img src="docs/screenshots/Desktop_Main_Menu.png" width="45%" alt="Home" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/Desktop_Tutorial.png" width="45%" alt="Onboarding Tutorial" />
</p>
<p align="center">
  <em>Home screen &nbsp;&nbsp;·&nbsp;&nbsp; Guided onboarding</em>
</p>

<p align="center">
  <img src="docs/screenshots/Desktop_DM_Conversation.png" width="45%" alt="DM Conversation" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/Conversation_Selfie.png" width="45%" alt="Conversation with Selfie" />
</p>
<p align="center">
  <em>Conversation Mode — Discord-style DMs with selfies and image generation</em>
</p>

<p align="center">
  <img src="docs/screenshots/Browser_Tab.png" width="90%" alt="Bot Browser" />
  <br/>
  <em>Bot Browser — Search and import characters from Chub.ai</em>
</p>

<p align="center">
  <img src="docs/screenshots/Browser_Game_Screen.png" width="90%" alt="Game Mode — Scene" />
  <br/>
  <em>Game Mode — AI Game Master, party of characters, generated backgrounds, weather, and time of day</em>
</p>

<p align="center">
  <img src="docs/screenshots/Browser_Game_Dialogue.png" width="45%" alt="Game Dialogue" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/Browser_Game_Party_Card.png" width="45%" alt="Party Card" />
</p>
<p align="center">
  <em>NPC dialogue tracking &nbsp;&nbsp;·&nbsp;&nbsp; Party member card with stats, levels, and abilities</em>
</p>

<p align="center">
  <img src="docs/screenshots/Mobile_Group_Conversation.png" width="30%" alt="Mobile Group Conversation" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="docs/screenshots/Mobile_Roleplay_View.png" width="30%" alt="Mobile Roleplay" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="docs/screenshots/Game_Mobile_Screen.png" width="30%" alt="Mobile Game Mode" />
</p>
<p align="center">
  <em>Fully responsive — Conversations, Roleplay, and Game Mode all work on phones and tablets via PWA</em>
</p>

</details>

---

## Latest Release

Current stable release: **[v2.0.8](https://github.com/Pasta-Devs/Marinara-Engine/releases/tag/v2.0.8)**.

See [CHANGELOG.md](CHANGELOG.md) for detailed release notes. Tagged releases use the `vX.Y.Z` format and are published on the [Releases](https://github.com/Pasta-Devs/Marinara-Engine/releases) page. Android APKs are Termux bootstrap + WebView shells: they can download Termux from F-Droid, launch Android's installer, start the Termux setup flow after required permission prompts, then open the local Marinara server on the same device.

---

## Roadmap

- Free-to-download mobile apps for Android and iPhone
- An engine feature for building and sharing full games with custom sprites, soundtracks, and scenarios
- New game modes: tabletop-style, point-and-click, and classic text adventures
- Ongoing improvements and bug fixes

More detailed public [roadmap](https://github.com/orgs/Pasta-Devs/projects/1).

---

## Installation

| Platform                     | Guide                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| 🐳 Docker / Podman           | [Container Installation Guide](docs/installation/containers.md) — recommended                   |
| 🪟 Windows                   | [Windows Installation Guide](docs/installation/windows.md)                                      |
| 🍎🐧 macOS / Linux           | [macOS / Linux Installation Guide](docs/installation/macos-linux.md)                            |
| 🤖 Android APK Bootstrap     | [Android APK Guide](android/README.md) — guided tap-through install/start shell                 |
| 🤖 Android Manual Termux     | [Android (Termux) Installation Guide](docs/installation/android-termux.md) — manual fallback    |
| 📱 iOS / iPadOS              | [iOS / iPadOS PWA Guide](docs/installation/ios-pwa.md)                                          |

> **Recommended Android path:** download the Android APK from the latest GitHub Release, open it, then tap **Install / Start Marinara**. The APK can download Termux from F-Droid, hand it to Android's installer, request Termux command permission, start the setup command, and open the local Marinara server when it is ready. If Android blocks that handoff, the APK copies a fresh-Termux setup command that can be pasted into Termux manually. Android still shows its required install/permission prompts.

Each guide covers installation, updating, and LAN access for that platform. See [Configuration Reference](docs/CONFIGURATION.md) for environment variables setup. Having trouble? See [FAQ](docs/FAQ.md) and [Troubleshooting](docs/TROUBLESHOOTING.md).

Upgrading from an older release? See [Upgrading to v2.0.0](docs/UPGRADING.md) for the platform-by-platform path from v1.6.1.

Security defaults are intentionally local-first: loopback access works out of the box, ordinary LAN and public clients require Basic Auth unless you explicitly opt back in, and Tailscale (`100.64.0.0/10`) plus Docker bridge (`172.16.0.0/12`) traffic are trusted by default for easier private installs. Set `BYPASS_AUTH_TAILSCALE=false` or `BYPASS_AUTH_DOCKER=false` if you want those clients to authenticate too. `ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK=true` restores unauthenticated access for other trusted private networks; public clients still require `ALLOW_UNAUTHENTICATED_REMOTE=true`. Powerful actions such as backups, bulk import, update apply, sidecar install/download/delete, haptics, and custom tool mutation also require `ADMIN_SECRET`; see [Access Control](docs/CONFIGURATION.md#access-control).

---

## Features

### Chat & Roleplay

Three chat modes — **Conversation** (Discord-style DMs), **Roleplay** (immersive RPG with sprites and backgrounds), and **Game** (AI Game Master with party, quests, and combat). Characters can share memory across modes. Create or import characters, search the Chub.ai bot browser, organize chats into folders, branch conversations, swipe between alternate responses, and import from SillyTavern.

### Visual & Immersive

Character expression sprites with automatic emotion switching, custom scene backgrounds, dynamic weather overlays, two visual themes (Y2K Marinara and SillyTavern classic), and light/dark mode.

### AI Agent System

20+ built-in agents that run alongside your chat — world state tracking, quest management, combat, expression detection, background selection, Narrative Director, prose analysis, Music DJ for Spotify/YouTube, CYOA choices, and more. Add only the agents you want to each chat, or create/import custom agents.

### Prompt Engineering

Preset system with drag-and-drop prompt ordering, lorebooks with keyword triggers, an AI lorebook maker, world info inspector, regex scripts, and a macro/template system.

### Connections & Providers

OpenAI, Anthropic, Google Gemini, Google Vertex AI, OpenRouter, NanoGPT, Mistral, Cohere, Pollinations, Stability AI, Together AI, NovelAI, ComfyUI, SD Web UI, Draw Things (Apple Silicon, Metal + Apple Neural Engine), and custom OpenAI-compatible endpoints. API keys are encrypted at rest with AES-256. Per-chat connection overrides.

### Export & Data

Export individual chats or bulk transcript zips as JSONL or plain text. Fully local file-native storage — all data stays on your machine. No account required.

---

## Hoshito TTRPG System

This fork adds a complete custom TTRPG ruleset to Marinara's Game Mode — the **Hoshito Simplified TTRPG Ruleset v1.1**. The GM is an LLM that actually knows the rules. Your character sheet lives in the engine. Encounters run mechanically. It's a real tabletop RPG, just with an AI at the table who never cancels on you.

Enable it per-character in the **Persona Editor → Hoshito Stats**, then start a Game Mode session. The GM picks up from there.

---

### Domains & Attributes

Every character has **three Domains**, each containing **three Attributes**. The defaults are:

| Domain | Attributes |
|--------|------------|
| **Physical** | MIG (Might), AGI (Agility), VIT (Vitality) |
| **Mental** | INT (Intellect), INS (Instinct), WIL (Will) |
| **Social** | CHA (Charisma), PSY (Presence), RES (Resolve) |

Domain and Attribute names are fully editable — rename them in the Persona Editor to fit any setting.

---

### Grades & Sparks

Attributes don't use flat numbers. They use a **14-tier Grade scale**:

`FFF → FF → F → E → D → C → B → A → S → SS → SSS → EX`

Each Grade represents a meaningful threshold, not just a +1. The GM uses Grade modifiers for all derived stat calculations (Health, Stagger, AP).

**Sparks** are the growth currency. Earn a Spark on an Attribute through play — reach 4 Sparks and it promotes to the next Grade. The **Vestige Spark** is a special carry-forward: if an Attribute is already at its cap, a Spark earned doesn't vanish; it becomes a Vestige that matters for Exaltation later.

**Verve** and **Story Points** are the session resources: Verve fuels special actions, Story Points let characters bend the narrative.

---

### Strands

A Strand is your character's mechanical identity — their specialisation path. Each Strand designates one **Primary Attribute** as its anchor. That Attribute gets a hard Spark cap of 4 and can't promote further through normal means; instead, it powers the Strand's escalating abilities.

Strands develop through play: new **Abilities** (no Spark cost, purely new axes of action) are unlocked by the GM at key moments. At **Level 13** the Strand reaches its Culmination Merit — a permanent signature ability. At **Level 14** the path forks: a second specialisation choice that shapes the character for the rest of the campaign.

---

### Merits & Core Merits

**Merits** are the rewards, discoveries, and consequences a character accumulates. There are five categories:

| Category | What it does |
|----------|-------------|
| **Feat** | A trained discipline. Grants 1 Attribute Spark. Two Feats can fuse into one stronger Feat at Level Up. |
| **Artifact** | A significant object. Grants 1 Attribute Spark. Weapons/Shields set the Mastery die size; Trinkets grant flat Power bonuses by rarity (+1 / +2 / +3 / +4). |
| **Ability** | A maneuver or technique. No Spark — a new axis of action, not a number going up. The primary reward of Strand progression. |
| **Augment** | Permanent, usually irreversible modification to the self. Grants Attribute Sparks directly. |
| **Contact** | A person, faction, or relationship. No Spark — purely narrative, but opens and closes doors that skill and power can't. |

A Merit can also be marked **Dormant** — acknowledged but not yet narratively active. The GM won't let it affect rolls or fiction until it's reactivated.

**Core Merits** are the three origin pillars every character starts with: **Ancestry**, **Heritage**, and **Background**. Each is a written origin that grants either one Grade step on a chosen Attribute, or a Spark if that Attribute is already at the Grade D creation cap.

At Levels 7, 14, 21, and 26 — or a narratively pivotal moment — a Core Merit can **transform**: it grants a new Ability, Feat, or Vestige Spark thematically linked to that origin's description. The more specific and evocative your origin writing, the more resonant the transformation the GM produces.

Both regular Merits and Core Merits are set in the **Persona Editor** before play, and edited from the **Game Mode Edit Sheet** during a campaign.

---

### Combat

Combat runs on the **Clash** system, not d20 vs. AC.

- Each combatant rolls **Speed Dice** at the start of a round to determine turn order.
- On your turn you spend **AP** (Action Points) to act. Default AP max is `3 + floor(WIL Grade mod / 3)`.
- Attacks are resolved by **Clash**: the attacker rolls a pool based on their relevant Attribute Grade, the defender rolls theirs. Higher total wins; the loser takes damage.
- **Coins** are the Clash resource: flip them to boost or modify rolls. Losing a Clash costs a Coin.
- **Morale** tracks the encounter's psychological tide. It shifts based on narrative outcomes, not just HP.
- **Power** is the damage number. Weapons set base Power; Trinket rarity adds flat bonuses. The Mastery Die (d6 through d12, set by weapon Artifact tier) adds a roll on top.

Damage types: **Slash, Pierce, Blunt** (physical) and **Spectral, Elemental, Empyreal** (supernatural).

---

### Resistance System

Each character has separate **Health** and **Stagger** resistance profiles per damage type, with six tiers:

| Tier | Multiplier | Meaning |
|------|-----------|---------|
| **Fatal** | ×2 | Double damage — a critical vulnerability |
| **Weak** | ×1.5 | Half again |
| **Normal** | ×1 | Standard |
| **Endured** | ×0.5 | Halved |
| **Ineffective** | ×0.25 | Mostly shrugged off |
| **Immune** | ×0 | No effect |

The GM calculates final damage as `floor(Power × multiplier)`. Characters with innate resistances require at least one Fatal vulnerability — you can't be a tank in every direction.

Health and Stagger are tracked separately: lose all Health and you're down; lose all Stagger and you're stunned/broken even if you're still standing.

---

### Exaltation

When a character reaches their Level 26 Domain cap, they face a choice: stop, or **Exalt**.

Exaltation resets one Domain's Attributes back to F, marking them with a `+` superscript (F+, then F++ on a second cycle). The cap extends to Level 52. It's not a regression — it's a metamorphosis. Vestige Sparks stored before the reset carry forward and fuel the Exalted progression differently than normal Sparks.

Exalted characters are tracked with a flag in the character sheet, and the GM knows to treat the `+`-marked Attributes as a distinct tier of potential rather than a simple downgrade.

---

## Documentation


| Document                                             | Description                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| [docs/INSTALLATION.md](docs/INSTALLATION.md)         | Installation guide index (all platforms)                        |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md)       | Environment variables and `.env` reference                      |
| [docs/IMAGE_GENERATION.md](docs/IMAGE_GENERATION.md) | Image provider setup, style profiles, and prompt cleanup        |
| [docs/EXTENSIONS.md](docs/EXTENSIONS.md)             | Extension folder manifests, package format, and examples        |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)   | Common issues and fixes                                         |
| [docs/FAQ.md](docs/FAQ.md)                           | Frequently asked questions (LAN access, etc.)                   |
| [docs/MACROS.md](docs/MACROS.md)                     | Prompt macro syntax, including weighted random choices          |
| [docs/PROFESSOR_MARI.md](docs/PROFESSOR_MARI.md)     | Built-in assistant capabilities, limits, and safety notes       |
| [docs/FRONTEND.md](docs/FRONTEND.md)                 | Frontend architecture, components, hooks, and API reference     |
| [docs/ARCHITECTURE_MAP.md](docs/ARCHITECTURE_MAP.md) | Code ownership map and module-boundary refactor groundwork      |
| [android/README.md](android/README.md)               | Android Termux bootstrap + WebView shell guide                  |
| [CONTRIBUTING.md](CONTRIBUTING.md)                   | Contributor workflow, validation, versioning, and release steps |
| [CHANGELOG.md](CHANGELOG.md)                         | Release notes                                                   |
| [CLAUDE.md](CLAUDE.md)                               | Maintainer notes for contributors using Claude                  |

---

## Community & Support

- [**Join Marinara's Discord**](https://discord.com/invite/KdAkTg94ME) — Chat, get help, share characters, and give feedback
- [**Support Marinara on Ko-fi**](https://ko-fi.com/marinara_spaghetti) — Help keep the project alive

---

## Contributors

<p align="left">
  <a href="https://github.com/Pasta-Devs/Marinara-Engine/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=Pasta-Devs/Marinara-Engine" alt="Marinara Engine contributors" />
  </a>
</p>

<p align="left">
  Made with <a href="https://contrib.rocks">contrib.rocks</a>.
</p>

---

## License

[AGPL-3.0](LICENSE)
