// Build-time constant injected via Vite `define`. `true` in the local Node build
// (vite.config.local.ts), `false` in the Cloudflare build (vite.config.ts).
// Used to dead-code-eliminate the filesystem data source out of the Worker.
declare const __LANEWORK_LOCAL__: boolean;
