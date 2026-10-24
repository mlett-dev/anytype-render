# anytype-render

Renders Anytype objects the way the Anytype app shows them: an image plus a
layout report. It runs the real Anytype frontend
([anytype-ts](https://github.com/anyproto/anytype-ts)) in its official web
mode, in a headless Chromium, against the heart (middleware) of a running
[anytype-cli](https://github.com/anyproto/anytype-cli). It backs the
`object-render` tool of
[anytype-extension-mcp](https://github.com/mlett-dev/anytype-extension-mcp).

## How it works

```
MCP (object-render) ──HTTP──▶ :31097 API ──▶ Playwright / Chromium
                                              │ loads
                              :31096 app ─────┤  static web build
                                              │  gRPC-web proxy with an allowlist
                                              ▼
                              heart gRPC-web 127.0.0.1:31011 (anytype-cli)
```

- The daemon runs as a container in the anytype-cli container's network
  namespace, like the MCP server does. Both ports listen on 127.0.0.1 inside
  that namespace only.
- **The browser never talks to heart directly.** It gets the daemon's own
  proxy (:31096) as its middleware address. Every other request is aborted
  and listed in the report under `blocked` — except reads from heart's file
  gateway (GET `/file/`, `/image/` on 127.0.0.1:478xx), which serves images.
  The only blocked request seen in practice is the frontend's Sentry
  endpoint.
- **An allowlist, not a denylist** (`service/src/policy.mjs`). `ALLOW` reaches
  heart, `LOCAL` is answered "ok" by the proxy itself, everything else is
  refused with PERMISSION_DENIED and reported as `rpc.refused`. `AccountSelect`
  passes only with the id of the account already running; any other id makes
  heart stop that account, which every other client shares.
- **One session per render.** `WalletCreateSession{token}` derives a session
  of its own from the base token; `ObjectClose` and `WalletCloseSession` follow
  the render. heart keeps a single event stream per token.
- Renders run one at a time. The browser stays warm and closes after 5 minutes
  without work.
- No recovery phrase needed: an init script hands the web mock
  (`electronMock`) the session token on `getTab`, sets `accountId`, closes the
  sidebars (`hideSidebar`) and marks onboarding hints as seen.

## What a render writes

- `ObjectOpen`: heart sets the object's `lastOpenedDate` as a device-local
  detail (no history, not synced) and registers the object for the session
  until `ObjectClose`.
- `WorkspaceOpen`: the same local `lastOpenedDate` on the space view. For a
  one-to-one space heart also runs its migration that creates the space chat
  when it is missing — as it does for any client opening that space.

Nothing else; the smoke test compares `block-list` before and after. Answered
locally because their effect is process- or account-wide:
`InitialSetParameters`, `FileSetAutoDownload` (persisted in the account
config otherwise), `FileAutoDownloadSetLimit`, `AccountPreloadRemainingSpaces`,
`AppSetDeviceState`.

Measured over 20 renders: heart grew by 27 MiB over the first 10 and by
0.8 MiB over the next 10 — warm caches; the frontend's subscriptions use fixed
ids and replace each other.

## Setup

```bash
cp local.env.example local.env      # container name, paths for the smoke test
scripts/build.sh v0.56.1 local      # frontend + image, tagged :local
```

Install `systemd/anytype-render.service` as a user unit (set `ExecStart` to
this checkout) and enable it. `scripts/run-anytype-render.sh` reads the
session token and the account id from the anytype-cli container with
`docker exec` and passes them on through the environment only (`-e NAME`,
never on a command line).

The daemon exits when heart rejects its token (tested: answer 503, exit code
1) or is unreachable three times in a row — the case of anytype-cli
restarting and its network namespace going away, which is **not tested**
because it cannot be staged safely. systemd then starts it again with a fresh
token in the new namespace; after an anytype-cli restart, check that `/health`
answers again:

```bash
docker exec anytype-render node -e 'fetch("http://127.0.0.1:31097/health").then(r=>r.text()).then(console.log)'
```

The MCP server finds the daemon through `ANYTYPE_RENDER_URL=http://127.0.0.1:31097`.

## Updating

The trigger is an anytype-cli update: it brings a new heart version, and both
the MCP server's heart pin and the matching frontend follow from it.

1. `scripts/pairing.sh` names the heart version anytype-cli runs and the newest
   stable anytype-ts release whose `middleware.version` has the same
   major.minor.
2. `scripts/build.sh <ref> test`
3. Run the test image in the foreground: `AR_TAG=test scripts/run-anytype-render.sh`
   (stop the production daemon first).
4. `scripts/smoke.sh` creates LIVETEST objects with the MCP live-test harness
   (a page with table, toggle and callout; a narrow table; page columns, a link
   and a relation; an image; an embedded query; a query object), renders each
   and checks: login, no refused call, nothing reached outside localhost, no
   request past the proxy, every content block in the DOM, `block-list`
   unchanged, the MCP usable meanwhile, a wrong id failing. Only the objects it
   created are erased afterwards.
5. On a refused call: **do not just allow it.** Read its handler in heart. A
   read goes into `ALLOW`; a global or persistent write goes into `LOCAL` or
   stays refused, and that part of the render is missing.
6. When green: `docker tag anytype-render:<ref> anytype-render:local` and
   restart the unit.

What an update can break, and the smoke test shows: the init script depends on
internal frontend names (`getTab`, `storeGet`, the storage keys `accountId`,
`hideSidebar`, `space.toggle`, `onboarding`), the report on the table classes
(`.scrollWrap`, `.table`, `.row`, `.cell`), and readiness detection on the
`pageMain…` page classes.

## Upstream quirks

- The production web build leaves out `dist/{img,font,embed,workers,assets,audio}`,
  which upstream's dev server serves instead. `frontend/Dockerfile` copies them
  in; without them all emoji are missing.
- In the web bundle, Prism's language loader throws `ReferenceError: Cannot
  access 'ec' before initialization`; code blocks may get plainer highlighting.
- When resuming by token, v0.56.1 opens no event stream. A still image does
  not need it: `ObjectOpen` and the subscriptions return the data.
- Pages scroll inside `#page`, not the document, and sets stretch their
  dataview to the window height. Full height is therefore taken from
  `#page.scrollHeight`, and the image is cut below the lowest visible element.
- On a space id that does not open, the frontend quietly shows another object.
  The proxy records whether the requested object itself was opened without
  error, and the render fails otherwise.

## Layout report

Per render: `layout` (edit, set, …), `content_width_px`, `height_px`, per table
the rendered column widths, `cut_off` (wider than the page), `cells_wrapped`,
`cells_clipped`, plus `clipped_blocks` and `images_failed`. With `"debug": true`
in the request it also lists the lowest visible elements (`debug_lowest`),
useful when height detection stops fitting after an update.

## License

MIT, see [LICENSE](LICENSE). This repository contains no Anytype code: the
frontend build clones anytype-ts at build time, and the resulting image
contains it under its own [Any Source Available
License](https://github.com/anyproto/anytype-ts/blob/develop/LICENSE.md). See
[NOTICE](NOTICE).
