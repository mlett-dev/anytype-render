// anytype-render: renders Anytype objects with the real anytype-ts frontend.
//
// Runs in the anytype-cli container's network namespace. Two listeners on
// 127.0.0.1:
//   APP_PORT  what the browser loads: the static web build, and a gRPC-web
//             proxy to heart that enforces policy.mjs. The browser is pointed
//             at this port as its middleware, so it never talks to heart
//             directly.
//   API_PORT  POST /render, GET /health for the MCP server. The browser is not
//             allowed to reach it.
//
// One render at a time. Each render gets its own heart session, derived from
// the base token, and closes it again: heart allows one event stream per
// token, so sharing the MCP's token would cut off anyone else's stream.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { ALLOW, LOCAL } from './policy.mjs';
import * as gw from './grpcweb.mjs';

const env = (name, fallback) => {
	const v = process.env[name] ?? fallback;
	if ((v === undefined) || (v === '')) {
		console.error(`${name} is required`);
		process.exit(2);
	}
	return v;
};

const WEB_ROOT = env('WEB_ROOT', '/web');
const HEART = env('HEART_GRPC_WEB', 'http://127.0.0.1:31011');
const APP_PORT = Number(env('APP_PORT', '31096'));
const API_PORT = Number(env('API_PORT', '31097'));
const ACCOUNT_ID = env('ACCOUNT_ID');
const BASE_TOKEN = env('SESSION_TOKEN');
const IDLE_CLOSE_MS = Number(env('IDLE_CLOSE_MS', '300000'));
const MAX_HEIGHT = Number(env('MAX_HEIGHT', '16000'));

const heartUrl = new URL(HEART);
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const VERSION = {
	frontend: readText('ANYTYPE_TS_REF'),
	middleware: readText('MIDDLEWARE_VERSION'),
};

function readText (name) {
	try {
		return fs.readFileSync(path.join(WEB_ROOT, name), 'utf8').trim();
	} catch {
		return '';
	}
}

const log = (...args) => console.log(new Date().toISOString(), ...args);

// --- the render in progress, as the proxy sees it ------------------------------

let current = null; // { token, objectId, rpc: {}, local: Set, refused: Set, openErrors: [], targetOpened }

// --- app listener: static files + gRPC-web proxy --------------------------------

const TYPES = {
	'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
	'.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
	'.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
	'.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg',
	'.bcmap': 'application/octet-stream',
};

function serveStatic (req, res) {
	// index.html loads /js and /css from the root and sets <base href="/dist/">
	// for relative assets, so both spellings map onto the build. Any other path
	// is an app route and gets index.html.
	const url = new URL(req.url, APP_ORIGIN);
	let rel;
	try {
		rel = path.normalize(decodeURIComponent(url.pathname).replace(/^\/(dist\/)?/, ''));
	} catch {
		res.writeHead(400).end();
		return;
	}
	if (rel.startsWith('..')) {
		res.writeHead(400).end();
		return;
	}
	let file = path.join(WEB_ROOT, 'index.html');
	const candidate = path.join(WEB_ROOT, rel);
	if (rel && (rel !== '.') && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
		file = candidate;
	}
	fs.readFile(file, (err, data) => {
		if (err) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
	});
}

function readBody (req, limit = 4 << 20) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (c) => {
			size += c.length;
			if (size > limit) {
				reject(new Error('body too large'));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

function refuse (res, contentType, status, message) {
	res.writeHead(200, gw.replyHeaders(contentType, status, message));
	res.end();
}

async function proxyGrpc (req, res, method) {
	const ct = req.headers['content-type'];
	const body = await readBody(req).catch(() => null);
	const run = current;
	if (!run || (body === null)) {
		refuse(res, ct, 14, 'no render in progress');
		return;
	}
	run.rpc[method] = (run.rpc[method] || 0) + 1;

	if (LOCAL.has(method)) {
		run.local.add(method);
		res.writeHead(200, gw.replyHeaders(ct));
		res.end(gw.okBody(ct));
		return;
	}
	if (!ALLOW.has(method)) {
		run.refused.add(method);
		refuse(res, ct, 7, 'refused by anytype-render');
		return;
	}
	if (req.headers.token !== run.token) {
		run.refused.add(`${method} (foreign token)`);
		refuse(res, ct, 16, 'not this render\'s session');
		return;
	}
	if (method === 'AccountSelect') {
		// Selecting any other account makes heart stop the running one, which
		// every MCP client shares.
		if (!gw.decodeBody(body, ct).includes(Buffer.from(ACCOUNT_ID))) {
			run.refused.add('AccountSelect (other account)');
			refuse(res, ct, 7, 'only the running account');
			return;
		}
	}

	const headers = {};
	for (const h of [ 'content-type', 'x-grpc-web', 'x-user-agent', 'token', 'grpc-timeout', 'accept' ]) {
		if (req.headers[h]) {
			headers[h] = req.headers[h];
		}
	}
	headers['content-length'] = body.length;
	const up = http.request({
		host: heartUrl.hostname, port: heartUrl.port, method: 'POST', path: req.url, headers,
	}, (upRes) => {
		res.writeHead(upRes.statusCode, upRes.headers);
		upRes.pipe(res);
		// ObjectOpen reports a missing object in its response, not as a gRPC
		// status; read it on the way through so a render fails fast. Whether
		// the requested object itself opened is recorded too: on a bad space
		// id the frontend quietly opens something else instead.
		if (method === 'ObjectOpen') {
			const isTarget = gw.decodeBody(body, ct).includes(Buffer.from(run.objectId));
			const chunks = [];
			upRes.on('data', c => chunks.push(c));
			upRes.on('end', () => {
				const frames = gw.parseFrames(gw.decodeBody(Buffer.concat(chunks), upRes.headers['content-type']));
				const data = frames.find(f => !(f.flag & 0x80));
				const err = data ? gw.responseError(data.payload) : null;
				if (err) {
					run.openErrors.push(err.description || `code ${err.code}`);
				} else if (isTarget && (upRes.statusCode === 200)) {
					run.targetOpened = true;
				}
			});
		}
	});
	up.on('error', (e) => {
		if (!res.headersSent) {
			refuse(res, ct, 14, `heart unreachable: ${e.message}`);
		} else {
			res.destroy();
		}
	});
	// Streams (ListenSessionEvents) end when the page goes away.
	res.on('close', () => up.destroy());
	up.end(body);
}

const app = http.createServer((req, res) => {
	const url = new URL(req.url, APP_ORIGIN);
	if (url.pathname.startsWith(gw.SERVICE_PREFIX) && (req.method === 'POST')) {
		proxyGrpc(req, res, url.pathname.slice(gw.SERVICE_PREFIX.length)).catch((e) => {
			log('proxy error', e.message);
			res.destroy();
		});
		return;
	}
	if (req.method !== 'GET') {
		res.writeHead(405).end();
		return;
	}
	serveStatic(req, res);
});

// --- browser -----------------------------------------------------------------

let browser = null;
let idleTimer = null;

async function getBrowser () {
	clearTimeout(idleTimer);
	if (!browser || !browser.isConnected()) {
		browser = await chromium.launch({ headless: true });
		log('browser started');
	}
	return browser;
}

function scheduleIdleClose () {
	clearTimeout(idleTimer);
	idleTimer = setTimeout(async () => {
		if (browser) {
			await browser.close().catch(() => {});
			browser = null;
			log('browser closed after idle');
		}
	}, IDLE_CLOSE_MS);
}

// heart's file gateway serves images and file content on 127.0.0.1:47800 and
// up (it moves on when the port is taken), under /file/ and /image/ only.
function isGateway (u, method) {
	const port = Number(u.port);
	return (u.hostname === '127.0.0.1') && (method === 'GET') && (port >= 47800) && (port < 47900) &&
		(u.pathname.startsWith('/file/') || u.pathname.startsWith('/image/'));
}

function initScript ({ accountId, token, theme, spaceId, objectId, expandIds, panelGroups }) {
	// Storage.get('accountId') reads the mock's store: JSON under "anytype_".
	localStorage.setItem('anytype_accountId', JSON.stringify(accountId));
	// Left sidebars closed: the render is the object, not the space around it.
	localStorage.setItem('anytype_hideSidebar', JSON.stringify(true));
	localStorage.setItem('anytype_config', JSON.stringify({
		theme: theme === 'dark' ? 'dark' : '', zoom: 0, interfaceLang: 'en-US', languages: [],
		hideTray: false, showMenuBar: true,
		flagsMw: { time: false, json: false, request: false, event: false, sync: false, file: false, subscribe: false },
	}));
	// Toggles shown open: per space and object, under the unprefixed local key
	// "space". The properties panel keeps its groups' toggles there too, under
	// its page name.
	const toggle = {};
	if (expandIds.length) {
		toggle[objectId] = expandIds;
	}
	if (panelGroups.length) {
		toggle['object/relation'] = panelGroups;
	}
	if (Object.keys(toggle).length) {
		localStorage.setItem('space', JSON.stringify({ [spaceId]: { toggle } }));
	}
	// The app resumes a session only when getTab returns a token, and the web
	// mock's tabs never carry one. Wrap the mock as entry.web.tsx installs it.
	let mock;
	Object.defineProperty(window, 'Electron', {
		configurable: true,
		get () { return mock; },
		set (value) {
			// Onboarding hints count as seen, whatever keys a frontend version
			// has: Storage.getOnboarding(key) is (storeGet('onboarding') || []).includes(key).
			const storeGet = value.storeGet;
			value.storeGet = (key) => (key === 'onboarding' ? { includes: () => true } : storeGet(key));
			const api = value.Api;
			value.Api = async (id, cmd, args = []) => {
				const ret = await api(id, cmd, args);
				if (cmd === 'getTab') {
					return { ...(ret || { id: args[0], data: {} }), token };
				}
				return ret;
			};
			mock = value;
		},
	});
}

// Where the content ends, in page pixels: the lowest leaf element that shows
// something (text, media, a painted surface). #page's scrollHeight is no
// measure: it includes the editor's bottom padding and never drops below the
// window, and sets stretch their dataview to the window height.
function contentBottom () {
	const all = [...document.querySelectorAll('#page *')];
	// Fixed elements (the discussion button) sit at the window's bottom edge.
	const fixed = all.filter(el => getComputedStyle(el).position === 'fixed');
	const media = new Set([ 'IMG', 'SVG', 'svg', 'CANVAS', 'VIDEO', 'INPUT', 'IFRAME' ]);
	// What the eye sees: text, media, or a painted surface. Drop targets
	// and resize sensors are leaves too, but invisible and stretched.
	const shows = (el, r) => {
		if ((el.textContent || '').trim() || media.has(el.tagName)) {
			return true;
		}
		const cs = getComputedStyle(el);
		const painted = (cs.backgroundImage !== 'none') || !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) ||
			(parseFloat(cs.borderTopWidth) > 0) || (parseFloat(cs.borderBottomWidth) > 0);
		return painted && (r.height < window.innerHeight * 0.8);
	};
	let max = 0;
	for (const el of all) {
		if (el.childElementCount || fixed.some(f => f.contains(el))) {
			continue;
		}
		const r = el.getBoundingClientRect();
		if ((r.height > 0) && (r.width > 0) && (getComputedStyle(el).visibility !== 'hidden') && shows(el, r)) {
			max = Math.max(max, r.bottom);
		}
	}
	// A full-page grid is virtualized: only the rows in the window are in the
	// DOM, but its inner container spans every loaded row.
	for (const el of document.querySelectorAll('#page .ReactVirtualized__Grid__innerScrollContainer')) {
		max = Math.max(max, el.getBoundingClientRect().bottom);
	}
	return Math.ceil(max);
}

// Measured in the page after it has settled. Facts a model cannot get from
// block-list: what the GUI actually made of widths and text. Selectors follow
// anytype-ts v0.56.1: block tables (component/block/table.tsx, table/row.tsx,
// table/cell.tsx) and dataview views (component/block/dataview.tsx,
// dataview/view/grid*), whose grid wraps in a .scrollWrap as well.
function layoutReport ({ objectId, expandIds, captureHeight, bottom }) {
	// Filters as words, the way the GUI labels them (lib/relation.ts
	// filterConditionsByType and the chip in dataview/filter, v0.56.1), with
	// what the GUI makes of each: applied, filtering nothing, or ignored.
	const describeFilters = (filters, { objectId, rel, exists, active, advanced }) => {
		const { I, S, translate: t } = window.Anytype.Lib;
		const C = I.FilterCondition;
		const T = I.RelationType;
		const Q = I.FilterQuickOption;
		const names = window.__arFilterNames || {};
		const labelKeys = {
			date: { [C.Equal]: 'filterConditionEqual', [C.Greater]: 'filterConditionGreaterDate', [C.Less]: 'filterConditionLessDate',
				[C.GreaterOrEqual]: 'filterConditionGreaterOrEqualDate', [C.LessOrEqual]: 'filterConditionLessOrEqualDate', [C.In]: 'filterConditionInDate' },
			list: { [C.In]: 'filterConditionInArray', [C.AllIn]: 'filterConditionAllIn', [C.NotIn]: 'filterConditionNotInArray', [C.Equal]: 'filterConditionEqual' },
			text: { [C.Like]: 'filterConditionLike', [C.NotLike]: 'filterConditionNotLike', [C.Equal]: 'filterConditionEqual', [C.NotEqual]: 'filterConditionNotEqual' },
		};
		const symbols = { [C.Equal]: '=', [C.NotEqual]: '≠', [C.Greater]: '>', [C.Less]: '<', [C.GreaterOrEqual]: '≥', [C.LessOrEqual]: '≤' };
		const listFormats = [ T.Select, T.MultiSelect, T.Object, T.File, T.Relations ];
		// Conditions the GUI menu does not offer keep their own name (ExactIn).
		const conditionLabel = (format, c) => {
			if ((c == C.Empty) || (c == C.NotEmpty)) {
				return t((c == C.Empty) ? 'filterConditionEmpty' : 'filterConditionNotEmpty');
			}
			// heart's Exists (17) is not in the frontend's enum at all.
			const own = C[c] || ((c == 17) ? 'Exists' : `condition ${c}`);
			if (format == T.Number) {
				return symbols[c] || own;
			}
			const table = (format == T.Date) ? labelKeys.date : (listFormats.includes(format) ? labelKeys.list : labelKeys.text);
			return table[c] ? t(table[c]) : own;
		};
		const iso = n => new Date(n * 1000).toISOString().slice(0, 10);
		let unknown = 0;
		const valueText = (f, r) => {
			if ([ C.Empty, C.NotEmpty ].includes(f.condition)) {
				return '';
			}
			const format = r?.format;
			const value = f.value;
			if (format == T.Date) {
				const q = f.quickOption || Q.ExactDate;
				if ((q != Q.ExactDate) && (q != Q.NumberOfDaysAgo) && (q != Q.NumberOfDaysNow)) {
					return t(`quickOption${q}`);
				}
				if (q != Q.ExactDate) {
					return `${value} (${t(`quickOption${q}`)})`;
				}
				if (typeof value === 'string') {
					return `"${value}" (text, which the GUI reads as ${iso(parseFloat(value) || 0)})`;
				}
				return ((value === null) || (value === undefined)) ? '' : iso(Number(value));
			}
			if (format == T.Checkbox) {
				return value ? 'checked' : 'unchecked';
			}
			if (listFormats.includes(format)) {
				const ids = (Array.isArray(value) ? value : [ value ]).filter(x => (x !== null) && (x !== undefined) && (x !== ''));
				return ids.map((id) => {
					const template = /^_filter_template_(\d+)_$/.exec(String(id));
					if (template) {
						return t(`filterTemplate${template[1]}`);
					}
					const d = S.Detail.get(objectId, id, [ 'name', 'isArchived', 'isDeleted' ], true);
					const name = (d && !d._empty_ && (d.name !== undefined)) ? d.name : names[id];
					if (name === undefined) {
						unknown++;
						return `unknown (${String(id).slice(-6)})`;
					}
					// A deleted tag is only archived and keeps its name, which
					// the GUI goes on showing; it matches nothing any more.
					if (d && !d._empty_ && (d.isArchived || d.isDeleted)) {
						unknown++;
						return `${name || t('defaultNamePage')} (deleted)`;
					}
					return name || t('defaultNamePage');
				}).join(', ');
			}
			if ((value === null) || (value === undefined)) {
				return '';
			}
			return (format == T.Number) ? String(value) : `"${value}"`;
		};
		const describe = (f) => {
			if (!f.relationKey && advanced(f)) {
				const word = (f.operator == I.FilterOperator.Or) ? 'or' : 'and';
				const rules = (f.nestedFilters || []).map(n => `(${describe(n)})`).join(` ${word} `);
				return `${word.toUpperCase()} group: ${rules}${active(f) ? '' : ' [filters nothing: no rule has a value]'}`;
			}
			const r = rel(f.relationKey);
			const before = unknown;
			const value = valueText(f, r);
			let text = `${r?.name || f.relationKey}: ${conditionLabel(r?.format, f.condition)}${value ? ` ${value}` : ''}`;
			if (!exists(r)) {
				text += ' [ignored: the property is deleted]';
			} else if (!active(f)) {
				text += ' [filters nothing: no value]';
			} else if (unknown > before) {
				text += ' [a value names nothing that exists]';
			}
			return text;
		};
		return filters.filter(Boolean).map(describe);
	};

	const page = document.querySelector('#page');
	const wrapper = document.querySelector('.editorWrapper');
	const blockId = el => el.closest('[id^="block-"]')?.id.slice('block-'.length) || null;
	const overflowsX = el => el.scrollWidth > el.clientWidth + 1;
	// Width of `inner` the GUI shows only after scrolling `box` sideways: what
	// reaches past the box's visible edge or the window's. An embedded grid's
	// scroll box spans the window while the grid starts in the text column, so
	// the box's width says nothing about how much is cut; and the box's
	// scrollWidth counts its padding, which is not content.
	const hiddenX = (inner, box) => {
		if (!inner || !box) {
			return 0;
		}
		const b = box.getBoundingClientRect();
		const edge = Math.min(b.left + box.clientLeft + box.clientWidth, window.innerWidth);
		return Math.max(0, Math.round(inner.getBoundingClientRect().right - edge));
	};
	// Cut by its box: wider than it, overflow hidden (an ellipsis is that too).
	const clipsX = el => overflowsX(el) && (getComputedStyle(el).overflowX !== 'visible');
	// In the picture: overlaps the captured area and is laid out at all.
	const captured = (el) => {
		const r = el.getBoundingClientRect();
		return (r.top < captureHeight) && (r.bottom >= 0) && (el.getClientRects().length > 0);
	};
	// Rendered text lines: distinct tops of the text's line boxes.
	const lines = (el) => {
		const range = document.createRange();
		range.selectNodeContents(el);
		return new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top))).size;
	};
	const first10 = list => list.slice(0, 10);
	const unique = list => [...new Set(list)];

	const tables = [...document.querySelectorAll('.scrollWrap')]
		.filter(w => w.querySelector('.table') && !w.closest('.blockDataview'))
		.map((wrap) => {
			const rows = [...wrap.querySelectorAll('.table .row')];
			const clipped = [];
			let wrapped = 0;
			rows.forEach((row, r) => [...row.querySelectorAll('.cell')].forEach((cell, c) => {
				const text = cell.querySelector('.editable');
				if (!text) {
					return;
				}
				if (overflowsX(text)) {
					clipped.push({ row: r, column: c });
				}
				if ((text.textContent || '').trim() && (lines(text) > 1)) {
					wrapped++;
				}
			}));
			return {
				block_id: blockId(wrap),
				column_widths_px: rows.length ? [...rows[0].querySelectorAll('.cell')].map(c => Math.round(c.getBoundingClientRect().width)) : [],
				width_px: Math.round(wrap.querySelector('.table').getBoundingClientRect().width),
				// Wider than the page: the GUI scrolls it sideways, so this much is hidden.
				cut_off_px: hiddenX(wrap.querySelector('.table'), wrap),
				cells_wrapped: wrapped,
				cells_clipped: clipped.length,
				clipped_cells: first10(clipped),
			};
		});

	// Queries and collections, embedded or as the object itself. Row counts
	// come from the frontend's record store (window.Anytype outside packaged
	// builds), the rest from the DOM.
	const S = window.Anytype?.Lib?.S;
	const keyOf = el => [...el.classList].find(c => c.startsWith('cell-key-'))?.slice('cell-key-'.length);
	const dataviews = [...document.querySelectorAll('.block.blockDataview')].map((block) => {
		const id = block.id.slice('block-'.length);
		const content = block.querySelector('.viewContent');
		const view = [...(content?.classList || [])].map(c => /^view(Grid|Board|Gallery|List|Calendar|Graph|Timeline)$/.exec(c)?.[1]).find(Boolean)?.toLowerCase() || null;
		// Every view type marks its rows or cards record-<id>; a board's
		// "new card" placeholder is record-<column>-add.
		const records = [...block.querySelectorAll('[id^="record-"]')].filter(el => !el.id.endsWith('-add'));
		const kind = block.querySelector('.isCollection') ? 'collection' : 'query';
		const out = { block_id: id, kind, view };
		// What it shows: an embedded view has views of its own, with their own
		// filters and sorts, whatever the query or collection it points at
		// shows when opened. The object's own dataview block is "dataview".
		try {
			const meta = S.Record.getMeta(S.Record.getSubId(objectId, id), '');
			const v = S.Record.getView(objectId, id, meta.viewId) || S.Record.getViews(objectId, id)[0];
			const target = (id === 'dataview') ? '' : S.Block.getLeaf(objectId, id)?.content?.targetObjectId;
			if (target) {
				const d = S.Detail.get(objectId, target, [ 'name', 'setOf' ]);
				out.source_id = target;
				out.source_name = d.name || '';
				if ((kind === 'query') && Array.isArray(d.setOf) && d.setOf.length) {
					out.query_of = d.setOf.map(t => S.Record.getTypeById(t)?.name || S.Detail.get(objectId, t, [ 'name' ]).name || t);
				}
			}
			if (v) {
				out.view_name = v.name || '';
				// What the GUI applies: filters on relations that still exist
				// (lib/dataview.ts getFilteredFilters), and of those the ones
				// with a value (lib/relation.ts isFilterActive, v0.56.1). The
				// filter bar shows the rest too, but they filter nothing.
				const I = window.Anytype.Lib.I;
				const rel = key => S.Record.getRelationByKey(key);
				const advanced = f => [ I.FilterOperator.And, I.FilterOperator.Or ].includes(f.operator);
				const exists = r => r && !r.isDeleted && !r.isArchived;
				const valueSet = (x) => {
					if ((x === null) || (x === undefined)) {
						return false;
					}
					if (Array.isArray(x) || (typeof x === 'string')) {
						return x.length > 0;
					}
					return (typeof x === 'number') || (typeof x === 'boolean') || !!x;
				};
				const active = (f) => {
					if (!f) {
						return false;
					}
					if (!f.relationKey && advanced(f)) {
						return (f.nestedFilters || []).some(active);
					}
					if (f.condition == I.FilterCondition.None) {
						return false;
					}
					if ([ I.FilterCondition.Empty, I.FilterCondition.NotEmpty ].includes(f.condition)) {
						return true;
					}
					const r = rel(f.relationKey);
					if (!r) {
						return false;
					}
					if ((r.format == I.RelationType.Date) && ((f.condition == I.FilterCondition.In) ||
						![ I.FilterQuickOption.NumberOfDaysAgo, I.FilterQuickOption.NumberOfDaysNow, I.FilterQuickOption.ExactDate ].includes(f.quickOption))) {
						return true;
					}
					return valueSet(f.value);
				};
				const shown = (v.filters || []).filter(f => f && (advanced(f) || exists(rel(f.relationKey))));
				const applied = shown.filter(active).length;
				out.filters = applied;
				if (shown.length > applied) {
					out.filters_inactive = shown.length - applied;
				}
				// On a deleted or archived property the GUI drops a filter or
				// sort without a trace, while the REST list endpoint applies it.
				const ignored = (v.filters || []).filter(f => f && !advanced(f) && !exists(rel(f.relationKey))).length;
				if (ignored) {
					out.filters_ignored = ignored;
				}
				out.sorts = (v.sorts || []).filter(x => x && exists(rel(x.relationKey))).length;
				const sortsIgnored = (v.sorts || []).filter(x => x && !exists(rel(x.relationKey))).length;
				if (sortsIgnored) {
					out.sorts_ignored = sortsIgnored;
				}
				// The filters and sorts in words, as the GUI labels them. The
				// image cuts a chip at a fixed width and shows a group only as
				// "N rules"; this says what each one does.
				const list = describeFilters(v.filters || [], { objectId, rel, exists, active, advanced });
				if (list.length) {
					out.filter_list = list;
				}
				const sortList = (v.sorts || []).filter(Boolean).map((x) => {
					const r = rel(x.relationKey);
					const dir = (x.type == I.SortType.Desc) ? 'descending' : ((x.type == I.SortType.Custom) ? 'custom order' : 'ascending');
					return `${r?.name || x.relationKey}: ${dir}${exists(r) ? '' : ' [ignored: the property is deleted]'}`;
				});
				if (sortList.length) {
					out.sort_list = sortList;
				}
			}
			const all = S.Record.getViews(objectId, id);
			if (all.length > 1) {
				out.views = all.map(x => x.name || x.id);
			}
			// Counts from the subscriptions a view type loads with. Grids, lists
			// and galleries use the block's own; a board one per column; a
			// calendar one per day of the month it shows, and the block's own
			// still holds what the view before it loaded, so it has no totals.
			const counts = (subIds) => {
				let total = 0;
				let loaded = 0;
				for (const sub of subIds) {
					total += Number(S.Record.getMeta(sub, '').total) || 0;
					loaded += S.Record.getRecordIds(sub, '').length;
				}
				return { total, loaded };
			};
			if ([ 'grid', 'list', 'gallery' ].includes(view) && Number.isFinite(meta.total)) {
				const c = counts([ S.Record.getSubId(objectId, id) ]);
				out.rows_total = meta.total;
				// Loaded, in the picture or not: the rest is behind Load more.
				out.rows_loaded = Math.max(records.length, c.loaded);
			} else if (view === 'board') {
				const groups = S.Record.getGroups(objectId, id).filter(g => !g.isHidden);
				const c = counts(groups.map(g => S.Record.getGroupSubId(objectId, id, g.id)));
				out.rows_total = c.total;
				out.rows_loaded = Math.max(records.length, c.loaded);
			} else if (view === 'calendar') {
				// The month it opens on, today's; rows_shown counts its entries.
				const d = new Date();
				out.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
			}
		} catch {}
		out.rows_shown = records.filter(captured).length;
		// The GUI's own sign that more rows exist than it shows.
		if (block.querySelector('.loadMore')) {
			out.load_more = true;
		}
		// The filter and sort bar is open: the image shows each filter.
		if (block.querySelector('.dataviewFilters')) {
			out.filter_bar = true;
		}
		if (!captured(block)) {
			out.in_image = false;
		}
		if ((view !== 'grid') || !content) {
			return out;
		}

		const head = [...content.querySelectorAll('.rowHead .cellHead')].filter(c => keyOf(c));
		const names = new Map(head.map(h => [ keyOf(h), (h.querySelector('.name')?.textContent || keyOf(h)).trim() ]));
		const scroll = block.querySelector('.scroll');
		// With "wrap content" on, cells grow instead of cutting their text.
		const wraps = content.classList.contains('wrapContent');
		// Per column: how many cells cut their text, and the width the longest
		// of them needs (the cell's width plus what its text runs over).
		const cut = new Map();
		let wrapped = 0;
		let truncated = 0;
		records.forEach((row) => {
			if (!captured(row)) {
				return;
			}
			for (const cell of row.querySelectorAll('.cell')) {
				const key = keyOf(cell);
				if (!key) {
					continue;
				}
				if (wraps) {
					wrapped += (lines(cell) > 1) ? 1 : 0;
					continue;
				}
				const over = Math.max(0, ...[ cell, ...cell.querySelectorAll('*') ].filter(clipsX).map(el => el.scrollWidth - el.clientWidth));
				if (over > 0) {
					const c = cut.get(key) || { cells: 0, needs: 0 };
					c.cells++;
					c.needs = Math.max(c.needs, Math.ceil(cell.getBoundingClientRect().width + over));
					cut.set(key, c);
					truncated++;
				}
			}
		});
		return {
			...out,
			columns: head.map((h) => {
				const c = cut.get(keyOf(h));
				return {
					name: names.get(keyOf(h)), width_px: Math.round(h.getBoundingClientRect().width),
					...(c ? { cells_truncated: c.cells, needs_px: c.needs } : {}),
				};
			}),
			width_px: Math.round(content.getBoundingClientRect().width),
			cut_off_px: hiddenX(content, scroll),
			...(wraps ? { cells_wrapped: wrapped } : { cells_truncated: truncated }),
		};
	});

	const textBlocks = [...document.querySelectorAll('[id^="block-"] .editable')].filter(el => !el.closest('.scrollWrap'));
	const images = [...document.querySelectorAll('#page img')].filter(img => !img.src.startsWith('data:') && captured(img));
	const where = img => blockId(img) || 'page';
	let kind = [...(page?.classList || [])].map(c => /^pageMain([A-Z][a-z]+)/.exec(c)?.[1]).find(Boolean)?.toLowerCase() || null;
	// Collections open in the same page component as sets.
	if ((kind === 'set') && document.querySelector('#block-dataview .isCollection')) {
		kind = 'collection';
	}

	return {
		layout: kind,
		content_width_px: wrapper ? Math.round(wrapper.getBoundingClientRect().width) : null,
		content_height_px: bottom,
		tables,
		dataviews,
		clipped_blocks: unique(textBlocks.filter(overflowsX).map(blockId).filter(Boolean)),
		images_failed: unique(images.filter(img => img.complete && (img.naturalWidth === 0)).map(where)),
		images_loading: unique(images.filter(img => !img.complete).map(where)),
		// Asked to be open but shown closed (or not shown): the frontend's
		// toggle storage, which the init script fills, no longer takes.
		toggles_not_open: expandIds.filter(id => !document.getElementById(`block-${id}`)?.classList.contains('isToggled')),
		blocks_in_dom: document.querySelectorAll('[id^="block-"]').length,
	};
}

// Views asked for, switched as a click on a view tab does (dataview/
// controls.tsx onViewSet): the block's viewId in the record store, which the
// dataview loads when it renders next, and in the block's content, which makes
// it render. The tab also sends BlockDataviewViewSetActive, which stores the
// device's active view; this does not (the proxy would refuse it). A view is named by id
// or by name; block_id may be left out when the object shows one view block.
function switchViews ({ objectId, wanted }) {
	const S = window.Anytype?.Lib?.S;
	const blocks = [...document.querySelectorAll('.block.blockDataview')].map(b => b.id.slice('block-'.length));
	const out = { switched: [], errors: [] };
	for (const { block_id: asked, view } of wanted) {
		const id = asked || ((blocks.length === 1) ? blocks[0] : '');
		if (!blocks.includes(id)) {
			out.errors.push(asked ? `no query or collection with block_id ${asked} is shown` : `block_id is needed: the object shows ${blocks.length} queries or collections`);
			continue;
		}
		const views = S.Record.getViews(objectId, id);
		const name = String(view || '').trim().toLowerCase();
		const v = views.find(x => x.id === view) || views.find(x => (x.name || '').trim().toLowerCase() === name);
		if (!v) {
			out.errors.push(`block ${id} has no view "${view}"; its views: ${views.map(x => x.name || x.id).join(', ')}`);
			continue;
		}
		S.Record.metaSet(S.Record.getSubId(objectId, id), '', { viewId: v.id });
		S.Block.updateContent(objectId, id, { viewId: v.id });
		out.switched.push({ block_id: id, view_id: v.id });
	}
	return out;
}

// The filter and sort bar under a view's tabs, opened as a click on the
// view's filter button opens it (dataview/controls.tsx onButton, then
// dataview.tsx toggleFilters): a toggle in the frontend's local storage,
// nothing is written. Only views whose bar is closed and has something to
// show: without filters the filter button opens the add-filter menu, so a
// view with sorts only gets its sort button. The toggle is kept per object
// and view id, and embedded blocks showing the same view share the id, so a
// click can close what an earlier one opened: the caller clicks each block
// until its own bar shows, at most twice. A menu that opens anyway (a
// read-only view) is closed again.
function filterBarButtons ({ objectId }) {
	const { S, I } = window.Anytype.Lib;
	const exists = (key) => {
		const r = S.Record.getRelationByKey(key);
		return r && !r.isDeleted && !r.isArchived;
	};
	const advanced = f => [ I.FilterOperator.And, I.FilterOperator.Or ].includes(f.operator);
	const out = [];
	for (const block of document.querySelectorAll('.block.blockDataview')) {
		const id = block.id.slice('block-'.length);
		const meta = S.Record.getMeta(S.Record.getSubId(objectId, id), '');
		const view = S.Record.getView(objectId, id, meta.viewId) || S.Record.getViews(objectId, id)[0];
		if (!view || block.querySelector('.dataviewFilters')) {
			continue;
		}
		const filters = (view.filters || []).some(f => f && (advanced(f) || exists(f.relationKey)));
		const sorts = (view.sorts || []).some(x => x && exists(x.relationKey));
		if (filters || sorts) {
			out.push({ block: id, button: `#button-${id}-${filters ? 'filter' : 'sort'}` });
		}
	}
	return out;
}

// loadFilterNames looks up the names of filter values the store does not hold
// (a deleted tag stays unknown: the search leaves out deleted and archived
// objects, as the GUI does) and leaves them in window.__arFilterNames.
function loadFilterNames ({ objectId, spaceId }) {
	const { S, C, I } = window.Anytype.Lib;
	const ids = new Set();
	const walk = fs => (fs || []).forEach((f) => {
		(Array.isArray(f?.value) ? f.value : [ f?.value ]).forEach((x) => {
			if ((typeof x === 'string') && /^bafy/.test(x) && S.Detail.get(objectId, x, [ 'name' ], true)._empty_) {
				ids.add(x);
			}
		});
		walk(f?.nestedFilters);
	});
	for (const block of document.querySelectorAll('.block.blockDataview')) {
		const id = block.id.slice('block-'.length);
		const meta = S.Record.getMeta(S.Record.getSubId(objectId, id), '');
		walk((S.Record.getView(objectId, id, meta.viewId) || S.Record.getViews(objectId, id)[0])?.filters);
	}
	if (!ids.size) {
		return Promise.resolve();
	}
	const list = [ ...ids ];
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, 3000);
		C.ObjectSearch(spaceId, [ { relationKey: 'id', condition: I.FilterCondition.In, value: list } ], [], [ 'id', 'name' ], '', 0, list.length, (message) => {
			const names = {};
			(message?.records || []).forEach((r) => {
				names[r.id] = r.name || '';
			});
			window.__arFilterNames = names;
			clearTimeout(timer);
			resolve();
		});
	});
}

// The properties panel the header's info button opens on the right
// (header/main/object.tsx onRelation, sidebar/page/object/relation.tsx,
// v0.56.1): the type's properties, then Hidden and Local, the keys the object
// holds that its type does not list. Local lists every key the object holds,
// whatever its value, so a key kept with a null value shows there as an empty
// field: null says so.
const PANEL_GROUPS = [ 'hidden', 'local' ];

function propertiesPanel ({ objectId }) {
	const { S } = window.Anytype.Lib;
	const panel = document.querySelector('#sidebarRight');
	const groups = panel ? [...panel.querySelectorAll('[id^="relationGroup-"]')] : [];
	if (!groups.length) {
		return null;
	}
	const raw = S.Detail.map?.get(objectId)?.get(objectId);
	const prefix = 'sidebarObjectRelation-';
	const suffix = `-${objectId}`;
	const sections = groups.map((group) => {
		// The cell itself, not the object chips inside it, whose ids share the prefix.
		const cells = [...group.querySelectorAll(`.wrap > .cell[id^="${prefix}"]`)].filter(cell => cell.id.endsWith(suffix));
		const properties = cells.map((cell) => {
			const key = cell.id.slice(prefix.length, cell.id.length - suffix.length);
			const wrap = cell.closest('.wrap') || cell.parentElement;
			const entry = { name: (wrap?.querySelector('.name')?.textContent || '').trim(), key };
			const stored = raw?.get ? raw.get(key) : undefined;
			if (cell.classList.contains('c-checkbox')) {
				entry.value = stored ? 'checked' : 'unchecked';
			} else
			if (cell.querySelector('.empty')) {
				entry.empty = true;
			} else {
				entry.value = (cell.innerText || '').replace(/\s+/g, ' ').trim();
			}
			if (stored === null) {
				entry.null = true;
			}
			return entry;
		});
		const id = group.id.slice('relationGroup-'.length);
		const name = (group.querySelector(':scope > .titleWrap .label')?.textContent || '').trim();
		return { section: id, ...(name ? { name } : {}), properties };
	});
	const closed = groups.filter(g => g.querySelector(':scope > .list.withToggle') && !g.querySelector(':scope > .list.isOpen'));
	return { sections, ...(closed.length ? { closed: closed.map(g => g.id.slice('relationGroup-'.length)) } : {}) };
}

// The window height the panel needs to show every property: its scrolling
// body's full height plus what sits around it.
function panelNeed () {
	const panel = document.querySelector('#sidebarRight');
	if (!panel) {
		return 0;
	}
	let need = 0;
	for (const el of panel.querySelectorAll('*')) {
		const cs = getComputedStyle(el);
		if (/(auto|scroll)/.test(cs.overflowY) && (el.scrollHeight > el.clientHeight)) {
			const r = el.getBoundingClientRect();
			need = Math.max(need, r.top + el.scrollHeight + (window.innerHeight - r.bottom));
		}
	}
	return Math.ceil(need);
}

// The lowest visible element of the panel, as contentBottom measures the page.
function panelBottom () {
	let max = 0;
	for (const el of document.querySelectorAll('#sidebarRight [id^="relationGroup-"] *')) {
		if (el.childElementCount) {
			continue;
		}
		const r = el.getBoundingClientRect();
		if ((r.height > 0) && (r.width > 0) && (getComputedStyle(el).visibility !== 'hidden') && (el.textContent || '').trim()) {
			max = Math.max(max, r.bottom);
		}
	}
	return Math.ceil(max);
}

function closeMenus () {
	const { S } = window.Anytype.Lib;
	S.Menu?.closeAll?.();
}

// Embedded queries and collections show one page of rows (the view's page
// limit, 10 by default) and a "Load more" button below, as in the GUI. With
// all_rows it is pressed until every row is there, up to ROW_CAP per view.
const ROW_CAP = 500;

// One press loads offset + 2 x the page limit rows (dataview/view/grid.tsx
// loadMoreRows, dataview.tsx loadData; list and gallery alike). Setting the
// offset first makes one press load up to the cap. Board columns count their
// own offset and take one press per page.
function pressLoadMore ({ objectId, cap }) {
	const S = window.Anytype?.Lib?.S;
	let pressed = 0;
	for (const block of document.querySelectorAll('.block.blockDataview')) {
		const buttons = [...block.querySelectorAll('.loadMore')];
		const rows = [...block.querySelectorAll('[id^="record-"]')].filter(el => !el.id.endsWith('-add')).length;
		if (!buttons.length || (rows >= cap)) {
			continue;
		}
		const id = block.id.slice('block-'.length);
		if (S && !block.querySelector('.viewContent.viewBoard')) {
			try {
				const subId = S.Record.getSubId(objectId, id);
				const meta = S.Record.getMeta(subId, '');
				const view = S.Record.getView(objectId, id, meta.viewId) || S.Record.getViews(objectId, id)[0];
				const limit = Number(view?.pageLimit) || (block.querySelector('.viewGallery') ? 12 : 10);
				const want = Math.min(meta.total || cap, cap);
				S.Record.metaSet(subId, '', { offset: Math.max(meta.offset || 0, want - 2 * limit) });
			} catch {}
		}
		buttons.forEach(b => b.click());
		pressed += buttons.length;
	}
	return pressed;
}

async function loadAllRows (page, objectId) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (!(await page.evaluate(pressLoadMore, { objectId, cap: ROW_CAP }))) {
			return true;
		}
		await page.waitForTimeout(300);
		await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
	}
	return false;
}

// Fonts, and the images inside the captured area, with a deadline: a picture
// taken while they load shows fallback glyphs and empty frames. Images below
// the captured area may never load (lazy) and do not count.
async function settle (page, captureHeight) {
	const fonts = await page.evaluate(() => Promise.race([
		document.fonts.ready.then(() => true),
		new Promise(resolve => setTimeout(() => resolve(false), 3000)),
	]));
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		const loading = await page.evaluate(h => [...document.querySelectorAll('#page img')].some((img) => {
			const r = img.getBoundingClientRect();
			return !img.complete && !img.src.startsWith('data:') && (r.top < h) && (r.bottom >= 0) && (img.getClientRects().length > 0);
		}), captureHeight);
		if (!loading) {
			break;
		}
		await page.waitForTimeout(200);
	}
	return { fonts };
}

async function render (opts) {
	const width = Math.min(Math.max(Number(opts.width) || 1280, 480), 3840);
	const minHeight = Math.min(Math.max(Number(opts.height) || 900, 400), MAX_HEIGHT);
	const theme = opts.theme === 'dark' ? 'dark' : 'light';
	const format = opts.format === 'png' ? 'png' : 'jpeg';
	const quality = Math.min(Math.max(Number(opts.quality) || 85, 40), 100);
	const fullHeight = opts.full_height !== false;
	const allRows = opts.all_rows === true;
	const wantViews = Array.isArray(opts.views) ? opts.views.filter(v => v && (typeof v === 'object')) : [];
	const showFilters = opts.show_filters === true;
	const showProperties = opts.show_properties === true;
	const wantImage = opts.image !== false;
	const expandIds = Array.isArray(opts.expand_ids) ? opts.expand_ids.map(String) : [];
	const { space_id: spaceId, object_id: objectId } = opts;
	if (!spaceId || !objectId) {
		throw Object.assign(new Error('space_id and object_id are required'), { status: 400 });
	}

	let token;
	try {
		token = await gw.createSession(HEART, BASE_TOKEN);
	} catch (e) {
		// A base token heart no longer accepts means anytype-cli restarted;
		// only a restart of this daemon picks up the new one.
		log('session failed, exiting for a restart:', e.message);
		setTimeout(() => process.exit(1), 100);
		throw Object.assign(new Error(`renderer cannot open a session: ${e.message}`), { status: 503 });
	}

	const run = { token, objectId, rpc: {}, local: new Set(), refused: new Set(), openErrors: [], targetOpened: false };
	current = run;
	const report = { console_errors: [], page_errors: [], blocked: new Set(), direct_heart: 0 };
	const t0 = Date.now();
	let context;
	try {
		const b = await getBrowser();
		context = await b.newContext({
			viewport: { width, height: minHeight },
			deviceScaleFactor: 1,
			colorScheme: theme,
			serviceWorkers: 'block',
		});
		await context.route('**/*', (route) => {
			const req = route.request();
			const u = new URL(req.url());
			if ((u.origin === APP_ORIGIN) || isGateway(u, req.method())) {
				return route.continue();
			}
			report.blocked.add(`${u.protocol}//${u.host}`);
			return route.abort();
		});
		// Anything addressed to heart itself, from the page or a worker, would
		// bypass the policy. route() aborts it; this counts the attempts.
		context.on('request', (r) => {
			if (new URL(r.url()).port === heartUrl.port) {
				report.direct_heart++;
			}
		});
		await context.routeWebSocket(/.*/, (ws) => {
			report.blocked.add(`websocket ${new URL(ws.url()).host}`);
			ws.close();
		});

		const page = await context.newPage();
		page.on('console', (m) => {
			if (m.type() === 'error') {
				report.console_errors.push(m.text().slice(0, 200));
			}
		});
		page.on('pageerror', e => report.page_errors.push(String(e).slice(0, 200)));
		await page.addInitScript(initScript, { accountId: ACCOUNT_ID, token, theme, spaceId, objectId, expandIds, panelGroups: showProperties ? PANEL_GROUPS : [] });

		const route = `/main/object/${encodeURIComponent(objectId)}/spaceId/${encodeURIComponent(spaceId)}`;
		await page.goto(`${APP_ORIGIN}${route}?server=${encodeURIComponent(APP_ORIGIN)}`);

		// Ready when the object's own layout page is up; pageMainObject is the
		// route that is still loading it.
		const deadline = Date.now() + 45000;
		let opened = false;
		while (!opened && !run.openErrors.length && (Date.now() < deadline)) {
			opened = await page.evaluate(() => /pageMain(?!Blank|Void|Object)[A-Z]/.test(document.querySelector('#page')?.className || ''));
			if (!opened) {
				await page.waitForTimeout(250);
			}
		}
		// The proxy records the response's end a moment after the page may
		// already show it.
		for (let i = 0; opened && !run.targetOpened && (i < 20); i++) {
			await page.waitForTimeout(100);
		}
		if (!opened || !run.targetOpened || !page.url().includes(encodeURIComponent(objectId))) {
			const why = run.openErrors[0] || (opened ? 'the frontend showed a different object (wrong space_id?)' : 'the page did not leave the loading route');
			throw Object.assign(new Error(`the object did not open: ${why}`), { status: 404 });
		}
		// Still loading after 10 s: take the picture anyway, and say so.
		const networkIdle = await page.waitForLoadState('networkidle', { timeout: 10000 }).then(() => true, () => false);
		await page.waitForTimeout(800);
		// Before the height is measured: another view or more rows change it.
		if (wantViews.length) {
			const { errors } = await page.evaluate(switchViews, { objectId, wanted: wantViews });
			if (errors.length) {
				throw Object.assign(new Error(errors.join('; ')), { status: 400 });
			}
			await page.waitForTimeout(300);
			await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
			await page.waitForTimeout(300);
		}
		if (showFilters) {
			// One block at a time: a click stores the toggle and renders its block.
			for (const { block, button } of await page.evaluate(filterBarButtons, { objectId })) {
				for (let i = 0; i < 2; i++) {
					if (await page.evaluate(id => Boolean(document.querySelector(`#block-${CSS.escape(id)} .dataviewFilters`)), block)) {
						break;
					}
					await page.evaluate(sel => document.querySelector(sel)?.click(), button);
					await page.waitForTimeout(150);
					await page.evaluate(closeMenus);
				}
			}
			await page.waitForTimeout(200);
		}
		const rowsLoaded = allRows ? await loadAllRows(page, objectId) : true;
		// The info button opens the panel; layouts without one (types,
		// properties) have none.
		let panelOpened = false;
		if (showProperties) {
			if (await page.evaluate(() => Boolean(document.querySelector('#button-header-relation')))) {
				await page.evaluate(() => document.querySelector('#button-header-relation').click());
				panelOpened = await page.waitForSelector('#sidebarRight [id^="relationGroup-"]', { timeout: 5000 }).then(() => true, () => false);
				// The panel slides in (J.Constant.delay.sidebar) and loads values.
				await page.waitForTimeout(600);
				await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
			}
		}

		const url = page.url();
		if (url.includes('/auth/')) {
			throw Object.assign(new Error('the frontend did not log in (landed on an auth page)'), { status: 502 });
		}

		await page.addStyleTag({ content: '.web-mode-indicator { display: none !important; }' });

		let height = minHeight;
		let truncated = false;
		if (fullHeight) {
			for (let i = 0; i < 2; i++) {
				let h = await page.evaluate(() => (document.querySelector('#page')?.scrollHeight || document.documentElement.scrollHeight));
				if (panelOpened) {
					h = Math.max(h, await page.evaluate(panelNeed));
				}
				const want = Math.min(Math.max(h, minHeight), MAX_HEIGHT);
				truncated = h > MAX_HEIGHT;
				if (want === height) {
					break;
				}
				height = want;
				await page.setViewportSize({ width, height });
				await page.waitForTimeout(400);
			}
		}

		const { fonts } = await settle(page, height);

		// Some layouts (sets, collections) report far more height than their
		// content uses, and their dataview stretches to fill the window. Cut
		// below the lowest leaf element (text, icon, row), which containers
		// stretched to the window cannot fake.
		const bottom = Math.max(await page.evaluate(contentBottom), panelOpened ? await page.evaluate(panelBottom) : 0);
		if (fullHeight) {
			const cut = Math.min(height, Math.max(320, bottom + 48));
			if (cut < height) {
				height = cut;
				await page.setViewportSize({ width, height });
				await page.waitForTimeout(200);
			}
		}
		// The picture holds the whole object only if it reaches the content's end.
		const complete = !truncated && (bottom <= height + 1);

		// Names of the tags and objects that filters name but the page did not
		// load, rules inside a filter group above all. ObjectSearch is a read.
		await page.evaluate(loadFilterNames, { objectId, spaceId }).catch(() => {});
		const layout = await page.evaluate(layoutReport, { objectId, expandIds, captureHeight: height, bottom });
		if (showProperties) {
			layout.properties_panel = (panelOpened && await page.evaluate(propertiesPanel, { objectId })) ||
				{ unavailable: 'this layout has no properties panel' };
		}
		const unsettled = [
			...(networkIdle ? [] : [ 'network' ]),
			...(fonts ? [] : [ 'fonts' ]),
			...(layout.images_loading.length ? [ 'images' ] : []),
			...(rowsLoaded ? [] : [ 'rows' ]),
		];
		if (opts.debug) {
			// Every stored filter, and whether the GUI applies it.
			layout.debug_filters = await page.evaluate((objectId) => {
				const { S } = window.Anytype.Lib;
				return [...document.querySelectorAll('.block.blockDataview')].map((block) => {
					const id = block.id.slice('block-'.length);
					const meta = S.Record.getMeta(S.Record.getSubId(objectId, id), '');
					const v = S.Record.getView(objectId, id, meta.viewId) || S.Record.getViews(objectId, id)[0];
					return { block_id: id, filters: (v?.filters || []).map(f => ({
						key: f.relationKey, condition: f.condition, operator: f.operator, value: JSON.stringify(f.value)?.slice(0, 40),
						relation: S.Record.getRelationByKey(f.relationKey) ? 'found' : 'missing',
					})) };
				});
			}, objectId);
			// The lowest leaf elements: what the height crop measured.
			layout.debug_lowest = await page.evaluate(() => [...document.querySelectorAll('#page *')]
				.filter(el => !el.childElementCount)
				.map(el => ({ el, r: el.getBoundingClientRect() }))
				.filter(x => (x.r.height > 0) && (x.r.width > 0))
				.sort((a, b) => b.r.bottom - a.r.bottom).slice(0, 5)
				.map(x => `${x.el.tagName}.${String(x.el.className).slice(0, 50)} bottom=${Math.round(x.r.bottom)} h=${Math.round(x.r.height)}`));
		}
		const image = wantImage ? await page.screenshot({ type: format, ...(format === 'jpeg' ? { quality } : {}) }) : Buffer.alloc(0);

		await gw.closeObject(HEART, token, spaceId, objectId).catch(e => log('ObjectClose:', e.message));

		return {
			image: image.toString('base64'),
			mime: format === 'png' ? 'image/png' : 'image/jpeg',
			width, height, truncated, complete, unsettled, theme,
			ms: Date.now() - t0,
			renderer: VERSION,
			layout,
			rpc: {
				refused: [...run.refused],
				answered_locally: [...run.local],
				calls: Object.values(run.rpc).reduce((a, b) => a + b, 0),
				methods: run.rpc,
			},
			blocked: [...report.blocked],
			direct_heart_requests: report.direct_heart,
			console_errors: report.console_errors.slice(0, 10),
			page_errors: report.page_errors.slice(0, 5),
		};
	} finally {
		current = null;
		if (context) {
			await context.close().catch(() => {});
		}
		await gw.closeSession(HEART, token).catch(e => log('WalletCloseSession:', e.message));
		scheduleIdleClose();
	}
}

// --- API listener ------------------------------------------------------------

let queue = Promise.resolve();

const api = http.createServer(async (req, res) => {
	const send = (status, obj) => {
		res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
	};
	if ((req.method === 'GET') && (req.url === '/health')) {
		send(200, { ok: true, ...VERSION, busy: Boolean(current) });
		return;
	}
	if ((req.method !== 'POST') || (req.url !== '/render')) {
		send(404, { error: 'not found' });
		return;
	}
	let opts;
	try {
		opts = JSON.parse((await readBody(req, 64 << 10)).toString('utf8'));
	} catch {
		send(400, { error: 'body must be JSON' });
		return;
	}
	const job = queue.then(() => render(opts));
	queue = job.catch(() => {});
	try {
		const out = await job;
		log('rendered', out.width, 'x', out.height, `${out.ms} ms`, out.rpc.refused.length ? `refused: ${out.rpc.refused.join(',')}` : '');
		send(200, out);
	} catch (e) {
		log('render failed:', e.message);
		send(e.status || 500, { error: e.message });
	}
});

// --- liveness: this process lives in anytype-cli's network namespace ---------
// When anytype-cli restarts, the namespace goes away and heart is unreachable
// from here; exiting lets the launcher start a fresh container in the new one.

let misses = 0;
setInterval(() => {
	const sock = net.connect({ host: heartUrl.hostname, port: Number(heartUrl.port) });
	sock.setTimeout(3000);
	const done = (ok) => {
		sock.destroy();
		misses = ok ? 0 : misses + 1;
		if (misses >= 3) {
			log('heart unreachable three times, exiting');
			process.exit(1);
		}
	};
	sock.on('connect', () => done(true));
	sock.on('error', () => done(false));
	sock.on('timeout', () => done(false));
}, 30000).unref();

app.listen(APP_PORT, '127.0.0.1', () => log(`app on ${APP_ORIGIN}`));
api.listen(API_PORT, '127.0.0.1', () => log(`api on http://127.0.0.1:${API_PORT}`, VERSION));

for (const sig of [ 'SIGTERM', 'SIGINT' ]) {
	process.on(sig, async () => {
		if (browser) {
			await browser.close().catch(() => {});
		}
		process.exit(0);
	});
}
