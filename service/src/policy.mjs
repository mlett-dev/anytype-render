// Which middleware calls the rendered frontend may make.
//
// The renderer shares heart with every MCP client, so the browser gets an
// allowlist, not a denylist: a new frontend version or another object type
// must not reach heart with a call nobody has looked at. The handler of every
// entry was read in anytype-heart v0.50.8 before it went in.
//
// ALLOW  reach heart. Reads and in-memory subscriptions, plus two opens:
//          ObjectOpen     sets the object's lastOpenedDate as a local detail
//                         (no history, not synced) and registers the object
//                         for the session until ObjectClose
//          WorkspaceOpen  the same lastOpenedDate on the space view; for a
//                         one-to-one space it also runs heart's migration that
//                         creates the space chat if it is missing
// LOCAL  answered "ok" by the renderer itself; heart never sees them. They
//        set process- or account-wide state at frontend startup:
//          InitialSetParameters   platform, telemetry, log level (heart refuses
//                                 a second set, but only after anytype-cli
//                                 made the first)
//          FileSetAutoDownload    persisted in the account config
//          FileAutoDownloadSetLimit  same
//          AccountPreloadRemainingSpaces  loads every space, not needed to
//                                 show one object
//          AppSetDeviceState      foreground/background for the whole heart
// Anything else is refused with PERMISSION_DENIED and listed in the report.
// Before adding a refused call here, read its handler; a write that is global
// or persistent belongs in LOCAL or stays refused.

export const ALLOW = new Set([
	'AccountSelect',             // guarded: only the running account (see proxy)
	'ListenSessionEvents',       // allowed, but v0.56.1 does not open it when resuming by token
	'WorkspaceOpen',
	'ObjectOpen',
	'ObjectShow',                // b.Show(), no Apply
	'ObjectSearch',
	'ObjectSearchSubscribe',
	'ObjectSearchUnsubscribe',
	'ObjectSubscribeIds',
	'ObjectCrossSpaceSearchSubscribe',
	'NotificationList',
	'FileNodeUsage',
	'ChatSubscribeToMessagePreviews',
]);

export const LOCAL = new Set([
	'InitialSetParameters',
	'FileSetAutoDownload',
	'FileAutoDownloadSetLimit',
	'AccountPreloadRemainingSpaces',
	'AppSetDeviceState',
]);
