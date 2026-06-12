// The root tsconfig has no DOM lib (server code), but e2e page.evaluate
// callbacks run in the browser. Minimal any-typed shim — runtime is Chromium.
declare var document: any;
