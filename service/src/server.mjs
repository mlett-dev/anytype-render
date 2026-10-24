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

function initScript ({ accountId, token, theme, spaceId, objectId, expandIds }) {
	// Storage.get('accountId') reads the mock's store: JSON under "anytype_".
	localStorage.setItem('anytype_accountId', JSON.stringify(accountId));
	// Left sidebars closed: the render is the object, not the space around it.
	localStorage.setItem('anytype_hideSidebar', JSON.stringify(true));
	localStorage.setItem('anytype_config', JSON.stringify({
		theme: theme === 'dark' ? 'dark' : '', zoom: 0, interfaceLang: 'en-US', languages: [],
		hideTray: false, showMenuBar: true,
		flagsMw: { time: false, json: false, request: false, event: false, sync: false, file: false, subscribe: false },
	}));
	// Toggles shown open: per space and object, under the unprefixed local key "space".
	if (expandIds.length) {
		localStorage.setItem('space', JSON.stringify({ [spaceId]: { toggle: { [objectId]: expandIds } } }));
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
	const page = document.querySelector('#page');
	const wrapper = document.querySelector('.editorWrapper');
	const blockId = el => el.closest('[id^="block-"]')?.id.slice('block-'.length) || null;
	const overflowsX = el => el.scrollWidth > el.clientWidth + 1;
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
				visible_width_px: Math.round(wrap.clientWidth),
				// Wider than the page: the GUI scrolls it sideways, so part is hidden.
				cut_off: overflowsX(wrap),
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
		const out = {
			block_id: id,
			kind: block.querySelector('.isCollection') ? 'collection' : 'query',
			view,
			rows_shown: records.filter(captured).length,
		};
		let total;
		try {
			total = S?.Record?.getMeta(S.Record.getSubId(objectId, id), '')?.total;
		} catch {}
		if (Number.isFinite(total)) {
			out.rows_total = total;
		}
		if ((view !== 'grid') || !content) {
			return out;
		}

		const head = [...content.querySelectorAll('.rowHead .cellHead')].filter(c => keyOf(c));
		const names = new Map(head.map(h => [ keyOf(h), (h.querySelector('.name')?.textContent || keyOf(h)).trim() ]));
		const scroll = block.querySelector('.scroll');
		// With "wrap content" on, cells grow instead of cutting their text.
		const wraps = content.classList.contains('wrapContent');
		const cut = [];
		let wrapped = 0;
		records.forEach((row, r) => {
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
				} else if ([ cell, ...cell.querySelectorAll('*') ].some(clipsX)) {
					cut.push({ row: r, column: names.get(key) || key });
				}
			}
		});
		return {
			...out,
			columns: head.map(h => ({ name: names.get(keyOf(h)), width_px: Math.round(h.getBoundingClientRect().width) })),
			width_px: Math.round(content.getBoundingClientRect().width),
			visible_width_px: scroll ? Math.round(scroll.clientWidth) : null,
			cut_off: scroll ? overflowsX(scroll) : false,
			...(wraps ? { cells_wrapped: wrapped } : { cells_truncated: cut.length, truncated_cells: first10(cut) }),
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
		await page.addInitScript(initScript, { accountId: ACCOUNT_ID, token, theme, spaceId, objectId, expandIds });

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

		const url = page.url();
		if (url.includes('/auth/')) {
			throw Object.assign(new Error('the frontend did not log in (landed on an auth page)'), { status: 502 });
		}

		await page.addStyleTag({ content: '.web-mode-indicator { display: none !important; }' });

		let height = minHeight;
		let truncated = false;
		if (fullHeight) {
			for (let i = 0; i < 2; i++) {
				const h = await page.evaluate(() => (document.querySelector('#page')?.scrollHeight || document.documentElement.scrollHeight));
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
		const bottom = await page.evaluate(contentBottom);
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

		const layout = await page.evaluate(layoutReport, { objectId, expandIds, captureHeight: height, bottom });
		const unsettled = [
			...(networkIdle ? [] : [ 'network' ]),
			...(fonts ? [] : [ 'fonts' ]),
			...(layout.images_loading.length ? [ 'images' ] : []),
		];
		if (opts.debug) {
			// The lowest leaf elements: what the height crop measured.
			layout.debug_lowest = await page.evaluate(() => [...document.querySelectorAll('#page *')]
				.filter(el => !el.childElementCount)
				.map(el => ({ el, r: el.getBoundingClientRect() }))
				.filter(x => (x.r.height > 0) && (x.r.width > 0))
				.sort((a, b) => b.r.bottom - a.r.bottom).slice(0, 5)
				.map(x => `${x.el.tagName}.${String(x.el.className).slice(0, 50)} bottom=${Math.round(x.r.bottom)} h=${Math.round(x.r.height)}`));
		}
		const image = await page.screenshot({ type: format, ...(format === 'jpeg' ? { quality } : {}) });

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
