# Projects

A project is a directory T3 Code works in. A person adds one from the sidebar, then
starts threads in it and can filter the thread list down to it.

## Sub-features

- `projects.add.sources`: "New project" opens a palette of sources: Local folder, Git
  URL, GitHub repository, plus Azure DevOps, Bitbucket, Forgejo / Gitea and GitLab
  marked "Setup Required".
- `projects.add.local`: choosing Local folder and a path adds the project and opens a
  draft for it.
- `projects.filter`: the "Filter threads by project" control lists every project.

## How to get to it (user POV)

- Sidebar: the "New project" icon button (`button[aria-label="New project"]`).
- Sidebar thread row menu: "Filter by <project>" and "Project settings".
- Settings > General has a "Project scope" selector that scopes the settings shown.
- URL `/projects/<projectKey>`.

## Driving it with `browser.mjs`

Preconditions: baseline from [README.md](README.md), wizard finished.

- Click "New project" → a dialog "Command palette" lists the Sources above
  (`projects.add.sources`).
- Click "Local folder", fill the combobox "Enter path (e.g. ~/projects/my-app)" with
  `$RUN/fixture/demo-app` → the Directories list shows `demo-app` and the button reads
  "Add (Enter)".
- Click "Add (Enter)" → the draft heading reads "What should we build in demo-app?" and
  the breadcrumb shows `demo-app` (`projects.add.local`; logged by `seed.mjs`).
- Open the filter control (`[aria-label="Filter threads by project"]`) → options "All
  projects", "DA demo-app", "SR server" (`projects.filter`).

## Gotchas

- The Git URL, GitHub and other clone sources, and the row menu's "Project settings" page,
  were not driven:
  they need network or credentials, so they are unverified.
- The filter control opens a listbox; read `[role="option"]` text, then press Escape.
  Selecting an option and checking that other projects' threads disappear is not in
  the script yet.

## Proves it works

After adding the fixture, the draft is for `demo-app`, and the project filter lists
both `demo-app` and `server`.
