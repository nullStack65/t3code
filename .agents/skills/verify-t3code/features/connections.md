# Connections (environments)

An environment is one running T3 server and the machine behind it. Connections shows
this computer, whether network access is on, and lets a person add other environments.

## Sub-features

- `connections.page`: the local environment is listed with its version and update
  state, network access is described, and an Add environment control exists.

## How to get to it (user POV)

- Settings > Connections (`/settings/connections`).
- The Connect step of the first-run wizard lists the same local environment.
- Not driven: Add environment (pairing another machine), Enable network access, Tailscale
  HTTPS, authorized clients, pairing links, WSL options, per-environment actions menu.

## Driving it with `browser.mjs`

Preconditions: baseline from [README.md](README.md).

- Gear, then "Connections" → text "primary-asus Version 0.0.42 · http://localhost:<web
  port>/ Up to date Network access Only this machine can connect. Restart with a
  non-loopback host for remote pairing. Environments Add environment …".

## Gotchas

- Do not enable network access or Tailscale HTTPS in a verify instance: both can open or
  re-point host-level listeners (Tailscale Serve replaced the live server's `:443`
  mapping once; see SKILL.md). Those entry points are unverified on purpose.
- The server version is the checkout's, not the installed `t3`'s; compare it with
  `apps/server/package.json` to confirm you are on the build under test.

## Proves it works

The page names the local environment with the build's version and says it is loopback
only.
