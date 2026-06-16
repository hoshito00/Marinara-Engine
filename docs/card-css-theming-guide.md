# Card CSS Theming Guide

Give your characters a unique visual identity in chat. This guide covers how to embed custom CSS in your character cards so their messages look exactly the way you want — safely scoped so a card can only ever style the chat, never the rest of the app.

---

## Quick Start

Paste a `<style>` block into your character's **Creator Notes** field (in the character editor) and save. When that character is active in a chat, Marinara extracts and applies the CSS automatically.

```html
<style>
  [data-card-css] {
    border-left: 3px solid #ff69b4;
    background: linear-gradient(90deg, rgba(255, 105, 180, 0.08) 0%, transparent 40%);
  }
</style>
```

This gives your character a pink accent on their messages.

> Card theming is **off by default**. Open **Chat Settings → Card Theming** and pick a mode (it only appears once an active character actually has CSS in its creator notes). See the modes below.

---

## How It Works

When a character with CSS in their creator notes is active, Marinara:

1. Extracts every `<style>` block from the creator notes,
2. Sanitizes the CSS (strips anything dangerous — see [What You Cannot Style](#what-you-cannot-style)),
3. Scopes it so it can only affect the chat, and
4. Injects it into the page inside an `@layer card-css` layer.

Users choose how it's applied via **Chat Settings → Card Theming** (per chat):

| Mode                   | What it does                                         |
| ---------------------- | ---------------------------------------------------- |
| **Disabled** (default) | No card CSS is applied — the character looks default |
| **Exclusive**          | Each character's CSS only affects their own messages |
| **Chat**               | All card CSS affects the entire chat area            |

**Exclusive** suits group chats where each character has its own look. **Chat** suits single-character experiences where the card themes the whole chat surface.

---

## The one scoping rule that matters

Your CSS is rewritten so it can only reach the chat. _How_ it's rewritten depends on the mode, and this trips people up:

- **Chat mode** scopes everything under the chat area (`.mari-card-css`). A selector like `.mari-message` matches normally — it's something _inside_ the area.
- **Exclusive mode** scopes everything under _each of your character's own message elements_. Those elements are the ones carrying `data-card-css`. **A class on that same element (e.g. `.mari-message`, or `.mari-typing-indicator`) will not match it in Exclusive** — only things _inside_ it will.

So the portable rule:

> **Use `[data-card-css]` to style the message element itself, and normal class selectors for everything inside it.**

`[data-card-css]` is rewritten to "this character's message" in Exclusive and "the chat area" in Chat, so it works in both modes. (`:root` and `body` are rewritten to the scope the same way.)

```css
[data-card-css] {
  /* the message wrapper (Exclusive) or the chat area (Chat) */
}
[data-card-css] .mari-message-body {
  /* the bubble inside it — matches in both modes */
}
```

If you write `.mari-message { … }` and it works in Chat but vanishes in Exclusive, this is why — switch it to `[data-card-css] { … }`.

---

## Mode-Specific CSS with `@chat-mode`

Different chat surfaces render differently. Wrap rules in `@chat-mode` blocks to target a specific surface; CSS outside any block applies everywhere.

```html
<style>
  /* Applies in ALL modes */
  .note-box {
    border: 1px solid #0f0;
    background: #000;
  }

  /* Only in Roleplay mode */
  @chat-mode roleplay {
    .camera-view {
      border: 2px solid rgba(0, 255, 0, 0.3);
      box-shadow: 0 0 20px rgba(0, 255, 0, 0.4);
    }
  }

  /* Only in Conversation mode */
  @chat-mode conversation {
    [data-card-css] {
      border-left: 2px solid #00ff00;
      border-radius: 1rem;
      padding: 0.75rem;
      background: rgba(0, 30, 0, 0.8);
    }
  }
</style>
```

Standard `@media` queries work normally inside `@chat-mode` blocks for responsive layouts.

> **Game mode** does not apply card CSS yet — a `@chat-mode game { … }` block is harmless but currently has no effect.

---

## What You Can Style

### Roleplay Mode

Roleplay messages can contain HTML, so you have the most creative freedom — style the message HTML your card (or your regex scripts) produces.

| Selector                                        | What it targets                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `[data-card-css]`                               | The message wrapper (this character's messages in Exclusive; the chat area in Chat) |
| `:root` / `body`                                | Rewritten to the scope automatically — same as `[data-card-css]`                    |
| `.mari-message`                                 | A message container                                                                 |
| `.mari-message-narrator`                        | Narrator messages                                                                   |
| `.mari-message-assistant`                       | Character messages                                                                  |
| `.mari-message-user`                            | User messages                                                                       |
| `.mari-message-bubble`, `.mari-message-content` | The bubble and the text container                                                   |
| Any custom class                                | Classes your message HTML injects (e.g. `.camera-view`, `.terminal-window`)         |
| `[data-grouped]`                                | Present on consecutive (continuation) messages from the same character              |

Works well: HTML structures, CSS animations (`@keyframes`, transitions), pseudo-elements (`::before`/`::after`), backgrounds, borders, shadows, gradients, and custom fonts (system/web-safe stacks, or embedded `@font-face` with font `data:` URIs).

### Conversation Mode

Conversation messages render as text + markdown. Theming here styles the existing message elements.

| Selector                                    | What it targets                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `[data-card-css]`                           | The message wrapper — your main target                                                           |
| `[data-card-css] .mari-message-body`        | The bubble container — background, border, corners, shadows                                      |
| `[data-card-css] .mari-message-meta`        | The header row (name + timestamp)                                                                |
| `[data-card-css] .mari-message-name`        | The display name                                                                                 |
| `[data-card-css] .mari-message-timestamp`   | The timestamp                                                                                    |
| `[data-card-css] .mari-message-content`     | The text container                                                                               |
| `[data-card-css] .mari-message-avatar`      | The avatar column; `.mari-message-avatar > div` is the avatar circle                             |
| `[data-card-css] p`, `[data-card-css] span` | Paragraphs and inline spans in the text                                                          |
| `[data-grouped]`                            | Continuation messages — use `[data-card-css]:not([data-grouped])` for the first message in a run |

**Example — message bubble:**

```css
@chat-mode conversation {
  [data-card-css] .mari-message-body {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    border: 1px solid rgba(100, 149, 237, 0.3);
    border-radius: 1rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  [data-card-css] .mari-message-name {
    color: #6495ed;
    text-shadow: 0 0 8px rgba(100, 149, 237, 0.5);
  }
  [data-card-css] .mari-message-content p {
    color: #e0e0ff;
    font-family: Georgia, serif;
  }
}
```

#### Typing Indicator

While a character generates a reply, Marinara shows a "_(name) is typing…_" row (in conversation mode, classic message style). It's themeable:

| Selector                 | What it targets                                                          |
| ------------------------ | ------------------------------------------------------------------------ |
| `.mari-typing-indicator` | The indicator row                                                        |
| `.mari-typing-dots`      | The animated dots wrapper — style the dots with `.mari-typing-dots span` |
| `.mari-typing-text`      | The "(name) is typing…" label                                            |

The character's name is also exposed on the row as a `data-typing-name` attribute, so you can compose your own label with `content: attr(data-typing-name)`.

> **Scoping note (Exclusive mode):** `data-card-css` sits **on** the `.mari-typing-indicator` row itself. So target the row with **no space** (`[data-card-css].mari-typing-indicator`) and its children **with a space** (`[data-card-css] .mari-typing-text`) — the same rule as messages above.

```css
@chat-mode conversation {
  /* recolor the label + dots */
  [data-card-css] .mari-typing-text {
    color: #c77b92;
    font-style: italic;
  }
  [data-card-css] .mari-typing-dots span {
    background: #e3a8bd;
  }

  /* or replace the label entirely, name included */
  [data-card-css] .mari-typing-text {
    display: none;
  }
  [data-card-css].mari-typing-indicator::after {
    content: attr(data-typing-name) " is cooking up a reply…";
    font-style: italic;
    color: #c77b92;
  }
}
```

#### Avatar

The conversation avatar is a 40px circle — reshape it with pure CSS:

```css
@chat-mode conversation {
  [data-card-css] .mari-message-avatar > div {
    border-radius: 8px; /* square it off — 0 = sharp, 50% = circle */
    box-shadow: 0 0 0 3px #fff; /* white sticker border */
  }
}
```

> Swapping the avatar _image_ per character (emoji / sprite / gallery / hide) is a separate upcoming feature — see issue #2592. The CSS reshaping above works today.

---

## What You Cannot Style

These are stripped by the sanitizer for security:

| Blocked                         | Why                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url(https://…)`                | Prevents network requests that could track users or exfiltrate data. Only `url(data:…)` is allowed, for inline images and embedded fonts.                                                                                        |
| `@font-face` with external URLs | Only `data:` font sources (`font/*`, `application/font*`, `application/x-font*`) are kept; the embedded family name is auto-namespaced so it can't override app fonts, and your `font-family` references are rewritten to match. |
| `@import`                       | Prevents loading external stylesheets.                                                                                                                                                                                           |
| `:has()` selectors              | Prevents probing elements outside the chat.                                                                                                                                                                                      |
| `content:` with HTML            | Decorative text is allowed, but `<` and `>` are stripped and text is capped at 200 chars. CSS functions like `attr()` and `counter()` are permitted (e.g. `content: attr(data-typing-name)`).                                    |
| `position: fixed`               | Converted to `position: absolute` to prevent full-screen overlays.                                                                                                                                                               |
| `!important`                    | Stripped, so card CSS can't force-override app styles.                                                                                                                                                                           |
| App theme tokens                | Declarations like `--primary: blue` or `--background: red` are stripped so card CSS can't repaint the app UI.                                                                                                                    |

Because card CSS is injected in an `@layer card-css` layer, a rule that fights a style the app already applies may not win — prefer properties the UI doesn't already set (borders, shadows, backgrounds the element lacks, opacity, custom colors).

**Custom fonts** — embed with base64 `data:` URIs, or use system/web-safe stacks:

```css
@font-face {
  font-family: "MyFont";
  src: url(data:font/woff2;base64,d09GMgAB...) format("woff2");
}
font-family: "Courier New", Consolas, monospace;
```

---

## Tips for Card Creators

1. **Use `[data-card-css]` as your root selector.** It works in both Exclusive and Chat modes (see [the scoping rule](#the-one-scoping-rule-that-matters)).
2. **Use `@chat-mode` blocks** so your card looks intentional in both roleplay and conversation, not just the surface you tested.
3. **Test in light and dark themes.** Use `rgba()` colors so they blend with any background.
4. **Keep animations subtle** — prefer `transition` over heavy `animation` for lower-end devices.
5. **Don't depend on internal utility classes.** Stick to the documented selectors (`[data-card-css]`, `.mari-message-body`, `.mari-message-name`, `.mari-message-content`, `.mari-typing-*`, `p`, `span`); other class names can change between versions.
6. **Use `@media (max-width: 768px)`** for phones and narrow windows.
7. **Theme the "typing…" state** — a little `.mari-typing-text` / `.mari-typing-dots span` styling goes a long way.

---

## Using an AI Assistant to Create Card CSS

If you'd rather not hand-write CSS, ask an AI assistant. A prompt template:

> I'm creating a character card for Marinara Engine (an AI chat app). The card has a "Creator Notes" field where I can embed `<style>` blocks. I need CSS that themes the character's messages.
>
> **Character concept:** [describe the aesthetic — e.g. "cyberpunk hacker, neon-green terminal vibes" or "soft cottagecore fairy, pink pastels"]
>
> **Technical constraints:**
>
> - Use `[data-card-css]` for the message wrapper element (it works in both "Exclusive" and "Chat" scoping modes); use normal class selectors for things inside it.
> - `[data-card-css] .mari-message-body` = the bubble (background / border / corners); `[data-card-css] .mari-message-content` = the text area; `[data-card-css] .mari-message-name` = the display name; `[data-card-css] .mari-message-avatar > div` = the avatar circle (override `border-radius`); `[data-card-css] p` = text paragraphs.
> - Style the "typing…" indicator via `[data-card-css] .mari-typing-text` and `[data-card-css] .mari-typing-dots span` (the name is available as `attr(data-typing-name)`).
> - Wrap roleplay-only CSS in `@chat-mode roleplay { … }` and conversation-only CSS in `@chat-mode conversation { … }`; CSS outside these applies everywhere.
> - `url(https://…)`, `@import`, `:has()`, and `!important` are blocked; `position: fixed` becomes `absolute`; app theme tokens (`--primary`, etc.) are stripped. Use `url(data:…)` and `rgba()` colors.
> - `[data-grouped]` marks continuation messages — use `:not([data-grouped])` for first-in-group.
>
> Output a single `<style>` block I can paste into the Creator Notes field.

**After generating:** paste into Creator Notes → open a chat with the character → Chat Settings → Card Theming → set **Exclusive** → send a test message → try switching Exclusive ↔ Chat to compare.

---

## Example: Multi-Mode Card CSS

```html
<style>
  /* Shared animation */
  @keyframes glow-pulse {
    0%,
    100% {
      box-shadow: 0 0 8px rgba(0, 255, 0, 0.2);
    }
    50% {
      box-shadow: 0 0 16px rgba(0, 255, 0, 0.4);
    }
  }

  /* Roleplay: immersive */
  @chat-mode roleplay {
    .terminal-window {
      background: #1a1a1a;
      border: 1px solid #0f0;
      border-radius: 8px;
      animation: glow-pulse 3s ease-in-out infinite;
    }
  }

  /* Conversation: clean bubbles */
  @chat-mode conversation {
    [data-card-css] .mari-message-body {
      background: linear-gradient(135deg, rgba(0, 30, 0, 0.85), rgba(0, 15, 0, 0.7));
      border: 1px solid rgba(0, 255, 0, 0.3);
      border-radius: 1rem;
    }
    [data-card-css] .mari-message-name {
      color: #00ff00;
      text-shadow: 0 0 8px rgba(0, 255, 0, 0.6);
      font-family: "Courier New", monospace;
    }
    [data-card-css] .mari-message-content p {
      font-family: "Courier New", monospace;
      color: #c0ffc0;
    }
  }
</style>
```
