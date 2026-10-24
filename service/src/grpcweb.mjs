// Minimal gRPC-web plumbing: frames, the few protobuf fields the daemon
// needs itself, and a locally answered "ok".
//
// gRPC-web frames are a flag byte (0x00 data, 0x80 trailers), a 4-byte
// big-endian length and the payload. The text variant (what the anytype-ts
// client sends) is the same bytes base64-encoded.

export const SERVICE_PREFIX = '/anytype.ClientCommands/';

export function frame (flag, payload) {
	const head = Buffer.alloc(5);
	head[0] = flag;
	head.writeUInt32BE(payload.length, 1);
	return Buffer.concat([ head, payload ]);
}

export function parseFrames (buf) {
	const out = [];
	let at = 0;
	while (at + 5 <= buf.length) {
		const flag = buf[at];
		const len = buf.readUInt32BE(at + 1);
		out.push({ flag, payload: buf.subarray(at + 5, at + 5 + len) });
		at += 5 + len;
	}
	return out;
}

export function isText (contentType) {
	return String(contentType || '').startsWith('application/grpc-web-text');
}

// A text-mode body may arrive as several base64 chunks, each with its own
// padding, so it is decoded piecewise.
export function decodeBody (buf, contentType) {
	if (!isText(contentType)) {
		return buf;
	}
	const parts = buf.toString('latin1').match(/[^=]*=*/g).filter(Boolean);
	return Buffer.concat(parts.map(p => Buffer.from(p, 'base64')));
}

// --- protobuf, only what is needed here -------------------------------------

function varint (n) {
	const out = [];
	while (n > 0x7f) {
		out.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	out.push(n);
	return Buffer.from(out);
}

export function stringField (field, value) {
	const bytes = Buffer.from(String(value), 'utf8');
	return Buffer.concat([ varint((field << 3) | 2), varint(bytes.length), bytes ]);
}

// Top-level fields of a message: varints as numbers, length-delimited as
// buffers. Enough to read a token, an error code and a description.
export function readFields (buf) {
	const fields = {};
	let at = 0;
	const readVarint = () => {
		let result = 0, shift = 0, b;
		do {
			b = buf[at++];
			result += (b & 0x7f) * 2 ** shift;
			shift += 7;
		} while (b & 0x80);
		return result;
	};
	while (at < buf.length) {
		const key = readVarint();
		const field = Math.floor(key / 8);
		const wire = key & 7;
		if (wire === 0) {
			fields[field] = readVarint();
		} else if (wire === 2) {
			const len = readVarint();
			fields[field] = buf.subarray(at, at + len);
			at += len;
		} else if (wire === 1) {
			at += 8;
		} else if (wire === 5) {
			at += 4;
		} else {
			break;
		}
	}
	return fields;
}

// Every anytype response carries its error as field 1: { code = 1, description = 2 }.
export function responseError (payload) {
	const error = readFields(payload)[1];
	if (!error) {
		return null;
	}
	const f = readFields(error);
	const code = f[1] || 0;
	return code ? { code, description: f[2] ? f[2].toString('utf8') : '' } : null;
}

// --- calls the daemon makes itself -------------------------------------------

export async function unary (base, method, message, token) {
	const headers = { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' };
	if (token) {
		headers.token = token;
	}
	const res = await fetch(base + SERVICE_PREFIX + method, {
		method: 'POST', headers, body: frame(0, message), signal: AbortSignal.timeout(15000),
	});
	const status = res.headers.get('grpc-status');
	const body = Buffer.from(await res.arrayBuffer());
	const frames = parseFrames(body);
	const trailer = frames.find(f => f.flag & 0x80);
	const trailerStatus = trailer ? /grpc-status:\s*(\d+)/i.exec(trailer.payload.toString())?.[1] : null;
	const grpcStatus = Number(status ?? trailerStatus ?? 0);
	if (!res.ok || grpcStatus !== 0) {
		const msg = res.headers.get('grpc-message') || (trailer ? /grpc-message:\s*(.*)/i.exec(trailer.payload.toString())?.[1] : '');
		throw new Error(`${method}: grpc status ${grpcStatus} ${decodeURIComponent(msg || '')}`.trim());
	}
	const data = frames.find(f => !(f.flag & 0x80));
	return data ? data.payload : Buffer.alloc(0);
}

export async function createSession (base, token) {
	// WalletCreateSessionRequest.token = 3; response: error = 1, token = 2.
	const payload = await unary(base, 'WalletCreateSession', stringField(3, token));
	const err = responseError(payload);
	if (err) {
		throw new Error(`WalletCreateSession: ${err.code} ${err.description}`);
	}
	const t = readFields(payload)[2];
	if (!t || !t.length) {
		throw new Error('WalletCreateSession returned no token');
	}
	return t.toString('utf8');
}

export async function closeObject (base, token, spaceId, objectId) {
	// ObjectCloseRequest: objectId = 2, spaceId = 3.
	return unary(base, 'ObjectClose', Buffer.concat([ stringField(2, objectId), stringField(3, spaceId) ]), token);
}

export async function closeSession (base, token) {
	// WalletCloseSessionRequest.token = 1.
	return unary(base, 'WalletCloseSession', stringField(1, token), token);
}

// --- answers for the browser ---------------------------------------------------

// An empty response message is what the client reads as success: no error
// field means code 0.
export function okBody (contentType) {
	const body = Buffer.concat([ frame(0, Buffer.alloc(0)), frame(0x80, Buffer.from('grpc-status:0\r\ngrpc-message:\r\n')) ]);
	return isText(contentType) ? Buffer.from(body.toString('base64')) : body;
}

export function replyHeaders (contentType, status = 0, message = '') {
	return {
		'content-type': isText(contentType) ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto',
		'grpc-status': String(status),
		'grpc-message': encodeURIComponent(message),
		'access-control-expose-headers': 'grpc-status,grpc-message',
	};
}
