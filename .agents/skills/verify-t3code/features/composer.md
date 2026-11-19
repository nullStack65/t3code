# Composer: pick a model, send, read the reply

A person types a task, picks a provider and model, sends it, and sees their message
and the agent's reply in the thread. In a project that is a git repo the first send also
creates a worktree.

## Sub-features

- `composer.model-picker`: the model button opens a dialog with provider tabs
  (Favorites, Codex, Claude, Cursor) and a searchable model list.
- `composer.send`: sending creates the thread, moves the URL to the real thread, and
  shows the user's message and the reply.
- `composer.worktree`: the first send in a "Coding · isolated worktree" draft creates a
  branch `t3code/<id>` and a worktree under `$RUN/home/worktrees/<project>/`.

## How to get to it (user POV)

- New-thread draft (`/draft/<id>`): model button, "Send message", Enter in the editor.
- Keybindings in Settings > Keybindings: model picker (`mod+shift+m`), and the other
  composer commands listed in [docs/user/keybindings.md](../../../../docs/user/keybindings.md).
- Not driven: attach files, queue or steer while a turn runs, slash and `$skill` menus,
  voice input, runtime-mode and workspace selectors.

## Driving it with `browser.mjs`

Preconditions: baseline from [README.md](README.md); draft open for `demo-app`.

- Click the model button (named after the default model, for example "GPT-5.6 Luna ·
  routing group") → a dialog with a "Providers" toolbar.
- Click "Cursor" → options "Auto", "Composer 2", "GPT-5.4", "Opus 4.6" (they come from the
  mock ACP agent, `composer.model-picker`).
- Click "Auto", click `[data-testid="composer-editor"]`, type the prompt, click "Send
  message" → within seconds the URL is `/<environmentId>/<threadId>`, the thread shows
  "You" with the prompt and "T3 Code" with `verify-t3code mock reply`, and the sidebar
  has a row titled with the prompt (`composer.send`).
- Read `git -C $RUN/fixture/demo-app worktree list` → a second entry
  `$RUN/home/worktrees/demo-app/t3code-<id> [t3code/<id>]` (`composer.worktree`).

## Gotchas

- Never send with the default model: it is a real Codex model, so the send is a live
  provider call. `seed.mjs` switches to Cursor > Auto first. The Cursor provider only
  exists because `launch.sh` points its binary at the mock.
- `T3_ACP_PROMPT_RESPONSE_TEXT` in `$RUN/bin/cursor-agent` sets the reply text; the
  default is `verify-t3code mock reply`. The mock cannot show real tool calls unless
  `T3_ACP_EMIT_TOOL_CALLS=1` is set there.
- The send button is disabled until the editor has text.

## Proves it works

The thread page shows the typed prompt as the user's message and the mock reply as the
agent's, the sidebar row is titled with the prompt, and the worktree exists on disk.
