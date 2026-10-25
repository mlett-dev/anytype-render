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
`AppSetDeviceState`; and `ObjectCleanupSuggestions`, which the frontend sends a
few seconds after opening a space for a sidebar badge.

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
3. Run the test image next to the production daemon, on its own name and
   ports: `AR_TAG=test AR_NAME=anytype-render-test AR_APP_PORT=31098
   AR_API_PORT=31099 scripts/run-anytype-render.sh`. With `AR_DEV_SRC=1` this
   checkout's `service/src` is mounted over the image's, so while working on
   the daemon a `docker restart anytype-render-test` replaces a rebuild.
4. `AR_NAME=anytype-render-test AR_API_PORT=31099 scripts/smoke.sh` creates
   LIVETEST objects with the MCP live-test harness — a page with table, toggle
   and callout (also in a 400 px window); a narrow table; nested toggles and a
   toggle heading; an empty page; page columns, a link and a relation; an
   image; a PDF; a page in the bin; an embedded query; a query object; a query
   that matches nothing; a collection of 14 (also in a 400 px window) and the
   same collection embedded — renders each and checks: login, no refused call,
   nothing reached outside localhost, no request past the proxy, every content
   block in the DOM, `block-list` unchanged, the MCP usable meanwhile, a wrong
   id failing, and the layout report per kind (table widths, grid rows shown
   and in total, cut-off cells, toggles open, images loaded, `complete`).
   Only the objects it created are erased afterwards.
5. On a refused call: **do not just allow it.** Read its handler in heart. A
   read goes into `ALLOW`; a global or persistent write goes into `LOCAL` or
   stays refused, and that part of the render is missing.
6. When green, build the image from the committed tree and switch to it:
   `docker build --build-context web=build/web-<ref> -t anytype-render:<tag> service`,
   `docker tag anytype-render:<tag> anytype-render:local`, restart the unit.

What an update can break, and the smoke test shows: the init script depends on
internal frontend names (`getTab`, `storeGet`, the storage keys `accountId`,
`hideSidebar`, `space.toggle`, `onboarding`); the report on the table classes
(`.scrollWrap`, `.table`, `.row`, `.cell`), the dataview classes
(`.blockDataview`, `.viewContent`, `.viewGrid`, `.isCollection`, `.rowHead`,
`.cellHead`, `.cell-key-…`, `#record-…`), the toggle class `isToggled`, and
the record store under `window.Anytype.Lib.S` for row totals; readiness
detection on the `pageMain…` page classes.

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
- A query's or collection's own page virtualizes its grid: only the rows in
  the window are in the DOM. The content height therefore includes the
  virtualized list's full extent, so a short window reports `complete: false`.
- Embedded views show a page of rows (the view's page limit, 10 by default)
  and a "Load more" button; `rows_shown` and `rows_total` make that visible.
  With `"all_rows": true` the daemon presses it until every row is there, up
  to 500 per view. One press loads the offset plus twice the page limit, so
  the daemon sets the offset in the record store first and one press does it
  (board columns count their own offset and take one press per page). An
  embedded view has views of its own, with their own filters: it is not the
  query it points at opened on its own.
- `"views": [{"block_id", "view"}]` shows other views than the active ones,
  by name or id, as a click on the view tab does: the block's `viewId` in the
  record store and in the block's content (which makes it render again). The
  tab also sends `BlockDataviewViewSetActive`, which only stores the device's
  active view; the daemon does not send it. `block_id` may be left out when
  the object shows one query or collection; an unknown view or block is a 400
  that lists what there is.
- An object in the bin opens read-only, with the bin banner at the top.

## Layout report

Per render, next to the image:

- `complete`: whether the image reaches the end of the content. `false` for
  the first screen of a longer object (`full_height: false`) and past
  `MAX_HEIGHT` (then `truncated` too).
- `unsettled`: what was still loading when the picture was taken — `network`
  (no quiet moment within 10 s), `fonts` (3 s), `images` (8 s, only images
  inside the captured area count; lazy ones below it never load), `rows`
  (`all_rows` still pressing "Load more" after 30 s).
- `image` is empty with `"image": false` in the request: the report alone.
- `layout`: the page kind (`edit`, `set`, `collection`, …), `content_width_px`,
  and `content_height_px`, the bottom of the lowest visible element.
  `#page.scrollHeight` is not used for it: it includes the editor's bottom
  padding and never drops below the window.
- `tables` (table blocks): rendered column widths, `width_px`, `cut_off_px`
  (the width the GUI shows only after scrolling sideways), `cells_wrapped`,
  `cells_clipped` and the first ten `clipped_cells` as row and column.
- `dataviews` (queries and collections, embedded or the object itself):
  `kind` (query or collection), `view` (grid, list, gallery, board, …); for
  an embedded view the object it points at (`source_id`, `source_name`, and
  for a query the types it lists, `query_of`); the active view's `view_name`
  with its `filters` and `sorts` counts, and `views`, the names of all of
  them, when there are several; `rows_shown` (in the image), `rows_loaded`
  (the rest is behind "Load more") and `rows_total` (from the frontend's
  record store); `in_image: false` when the block lies outside the picture;
  for a grid also `columns` (name, width, and for a column with cut-short
  text `cells_truncated` and `needs_px`, the width its longest text needs),
  `width_px`, `cut_off_px`, and `cells_truncated` in total — or
  `cells_wrapped` when the view has "wrap content" on. An embedded grid's
  scroll box spans the window while the grid starts in the text column, so
  `cut_off_px` measures past the box's scroll range and past the window's
  edge, not the box's width. A calendar shows the entries of one month, and
  `rows_shown` counts those.
- `clipped_blocks`, `images_failed` and `images_loading` as block ids, and
  `toggles_not_open`: ids asked to open that are shown closed.

With `"debug": true` in the request it also lists the lowest visible elements
(`debug_lowest`), useful when height detection stops fitting after an update.

## License

MIT, see [LICENSE](LICENSE). This repository contains no Anytype code: the
frontend build clones anytype-ts at build time, and the resulting image
contains it under its own [Any Source Available
License](https://github.com/anyproto/anytype-ts/blob/develop/LICENSE.md). See
[NOTICE](NOTICE).
