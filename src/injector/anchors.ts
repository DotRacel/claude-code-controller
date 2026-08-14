/**
 * anchors.ts — THE INJECTION SURFACE, centralized (version-fragile facts).
 *
 * When a Claude Code update lands, THIS is the first (usually only) file to review.
 * Nothing here depends on stable minified symbol names: every gate is located at RUNTIME
 * by reading the bundle source (via `Bun.file(Bun.main).text()` inside the target) and
 * matching STRING / STRUCTURAL anchors, then extracting the current minified local aliases
 * with a regex. So an update that only reshuffles names keeps working; only a change to the
 * surrounding *code shape* (the guard expressions themselves) needs edits.
 *
 * Empirically established (see the probes under our own history + cc-injector):
 *  - `--inspect` flag is rejected; `BUN_INSPECT=ws://…?wait=1` opens the channel AND pauses
 *    the whole app before user code runs.
 *  - `?wait=1` is released by the WebKit `Inspector.initialized` message (NOT
 *    `Runtime.runIfWaitingForDebugger`, which JSC lacks). Sequence:
 *    Inspector.enable → Runtime.enable → Debugger.enable → (set breakpoints) →
 *    Inspector.initialized  ⇒ execution resumes and hits our pending breakpoints.
 *  - In the wait state we CAN `Runtime.evaluate` + `Bun.file().text()` (promise resolves),
 *    so we locate every gate before releasing — zero startup race.
 *  - The embedded bundle's virtual-fs path is NOT stable across versions — ≤2.1.228 it's
 *    `/$bunfs/root/src/entrypoints/cli.js`, ≥2.1.229 it's the flattened `/$bunfs/root/cli`
 *    (confirmed by probe). A hardcoded guess made every gate lookup ENOENT below 2.1.229, so
 *    every locator here reads `Bun.main` at runtime instead and reports it back so the Node
 *    side can point `Debugger.setBreakpointByUrl` at the same URL.
 *  - `Debugger.setBreakpointByUrl` accepts a breakpoint on a not-yet-parsed script
 *    (pending, locations:[]) and it fires once the bundle parses after release.
 *  - On pause, `Debugger.evaluateOnCallFrame` can REBIND a local alias in that frame
 *    (`alias = function(){…}`); the guard that reads it right after sees the new value.
 */

/** Config the rebinds need at runtime (filled in by gate-rebind, not fragile). */
export interface RebindConfig {
  bridgeBaseUrl: string; // e.g. http://127.0.0.1:PORT — becomes getBridgeBaseUrl()
  bridgeToken: string; // becomes getBridgeAccessToken()
}

/**
 * A gate = one breakpoint site inside a consumer function.
 *  - windowAnchor/back/fwd: slice of source to search in (keeps regexes unambiguous).
 *  - aliases: name → regex whose capture group 1 is the CURRENT minified local alias.
 *  - bpSubstr: substring (after ${alias} substitution) whose index is the breakpoint col.
 *  - rebinds: statements (after ${alias}/${TOKEN}/${URL} substitution) run in the paused
 *    frame to neutralize the guard.
 */
export interface GateSpec {
  id: string;
  windowAnchor: string;
  windowBack: number;
  windowFwd: number;
  aliases: Record<string, string>;
  bpSubstr: string;
  rebinds: string[];
}

// dispatch() remote-control branch (anchor: telemetry marker "cli_bridge_path"), and
// bridgeMain() (anchor: the http-scheme check string). Guard shapes captured from 2.1.231.
export const GATES: GateSpec[] = [
  // ── dispatch: hasStoredOAuthToken + getBridgeDisabledReason + checkBridgeMinVersion.
  // h/g are destructured BEFORE H, so at the `if(!H())` pause they're already visible.
  {
    id: 'dispatch.oauth',
    windowAnchor: 'cli_bridge_path',
    windowBack: 0,
    windowFwd: 3200,
    aliases: {
      H: 'hasStoredOAuthToken:([\\w$]+)\\}',
      h: 'getBridgeDisabledReason:([\\w$]+)[,}]',
      g: 'checkBridgeMinVersion:([\\w$]+)[,}]',
    },
    bpSubstr: 'if(!${H}())',
    rebinds: ['${H}=function(){return !0}', '${h}=async function(){return null}', '${g}=function(){return null}'],
  },
  // ── dispatch: isPolicyAllowed("allow_remote_control")
  {
    id: 'dispatch.policy',
    windowAnchor: 'cli_bridge_path',
    windowBack: 0,
    windowFwd: 3600,
    aliases: { R: 'isPolicyAllowed:([\\w$]+)\\}' },
    bpSubstr: '!${R}("allow_remote_control")',
    rebinds: ['${R}=function(){return !0}'],
  },
  // ── dispatch: trusted-device enrollment + unenrolled-reason (await W(); F=await G(); if(F))
  {
    id: 'dispatch.trust',
    windowAnchor: 'cli_bridge_path',
    windowBack: 0,
    windowFwd: 3600,
    aliases: {
      W: 'enrollTrustedDeviceIfNeeded:([\\w$]+)\\}',
      G: 'getTrustedDeviceUnenrolledReason:([\\w$]+)[,}]',
    },
    bpSubstr: 'await ${W}()',
    rebinds: ['${W}=async function(){}', '${G}=async function(){return null}'],
  },
  // ── bridgeMain: workspace-trust gate `if(…,!<trust>())` before token/baseurl.
  {
    id: 'bridgeMain.trust',
    windowAnchor: 'base URL uses HTTP',
    windowBack: 4000,
    windowFwd: 200,
    aliases: { t: 'checkHasTrustDialogAccepted:([\\w$]+)\\}' },
    bpSubstr: ',!${t}())',
    rebinds: ['${t}=function(){return !0}'],
  },
  // ── bridgeMain: getBridgeAccessToken guard + getBridgeBaseUrl consume.
  // M,P destructured together → rebind both at the `if(!M())` pause: M→token, P→our URL.
  {
    id: 'bridgeMain.tokenurl',
    windowAnchor: 'base URL uses HTTP',
    windowBack: 4000,
    windowFwd: 200,
    aliases: { M: 'getBridgeAccessToken:([\\w$]+),', P: 'getBridgeBaseUrl:([\\w$]+)\\}' },
    bpSubstr: 'if(!${M}())',
    rebinds: ['${M}=function(){return ${TOKEN}}', '${P}=function(){return ${URL}}'],
  },
  // ── bridgeMain: inline scheme check after `let U=P()`.
  // `if(U.startsWith("http://")&&!U.includes("localhost")&&!U.includes("127.0.0.1")) process.exit(1)`.
  // U is a primitive string, so `U.startsWith=fn` is discarded. One-shot-patch
  // String.prototype.startsWith: this check returns false, then the original is restored.
  {
    id: 'bridgeMain.httpscheme',
    windowAnchor: 'Error: Remote Control base URL uses HTTP',
    windowBack: 200,
    windowFwd: 40,
    aliases: { U: 'let ([\\w$]+)=[\\w$]+\\(\\);if\\(\\1\\.startsWith\\("http://"\\)' },
    bpSubstr: 'if(${U}.startsWith("http://")',
    rebinds: ['var _s=String.prototype.startsWith;String.prototype.startsWith=function(){String.prototype.startsWith=_s;return!1}'],
  },
  // ── spawner: the point where bridgeMain spawns the child claude. Special-cased in
  // gate-rebind: on hit we set <env>.BUN_INSPECT so the child opens its own inspector,
  // then attach + rebind the child too (it has its own --sdk-url allowlist gate).
  {
    id: 'spawner.spawn',
    windowAnchor: '--replay-user-messages',
    windowBack: 0,
    windowFwd: 1200,
    aliases: { L: 'env:([\\w$]+),windowsHide' },
    // Break BEFORE the spawn call (the `.spawn(` site fires AFTER the child is already
    // spawned). The env object `l` is defined just before this debug log, so pausing here
    // lets us mutate l.BUN_INSPECT before the spawn reads it.
    bpSubstr: 'Spawning sessionId',
    rebinds: [], // handled specially (needs the child inspector port at runtime)
  },
];

/**
 * Child-process locator: the spawned `claude --print --sdk-url …` has its OWN gate —
 * `dHs()` (getSdkUrl allowlist check) rejects a non-Anthropic host / non-wss scheme,
 * failing both the startup arg check (via `cku`) and the runtime getSdkUrl. Rebinding
 * `dHs` to return {status:'ok', url:<the --sdk-url value>} passes both. This locator
 * finds dHs's minified name and the breakpoint line/col right before the startup check.
 */
export function buildChildLocatorExpr(globalKey: string): string {
  const K = JSON.stringify(globalKey);
  return `
    globalThis[${K}] = "pending";
    (async () => {
      try {
        var MAIN = Bun.main;
        var s = await Bun.file(MAIN).text();
        function lc(i){ var pre=s.slice(0,i); var nl=pre.lastIndexOf("\\n"); return { line: pre.split("\\n").length-1, col: i-(nl+1) }; }
        var out = { main: MAIN, total_lines: s.split("\\n").length };
        // dHs name: locate uHs("--sdk-url"), walk back to the enclosing function name.
        var si = s.indexOf('("--sdk-url")');
        out.sdkUrlIdx = si;
        // NB: minified names can contain '$' (e.g. dHs = "l$s"), so match [\\w$]+ not \\w+.
        if (si >= 0) {
          var b1 = s.slice(si - 200, si);
          var mm = /function ([\\w$]+)\\(\\)\\{[^{}]*$/.exec(b1);
          out.dHs = mm ? mm[1] : null;
        } else out.dHs = null;
        // breakpoint: the \`let nn=cku(J);if(nn!==null)\` right before the reject telemetry.
        var ci = s.indexOf("tengu_sdk_url_host_rejected");
        if (ci >= 0) {
          var back = s.slice(ci - 240, ci);
          var m2 = /let [\\w$]+=[\\w$]+\\([^)]*\\);if\\([\\w$]+!==null\\)/.exec(back);
          if (m2) { var abs = ci - 240 + back.indexOf(m2[0]); var p = lc(abs); out.bpLine = p.line; out.bpCol = p.col; }
        }
        globalThis[${K}] = out;
      } catch (e) { globalThis[${K}] = "ERR:" + (e && e.message || e); }
    })();
    "kicked";`;
}

/** Rebind expression for the child's dHs (getSdkUrl allowlist check). */
export function childDhsRebind(dHsName: string): string {
  return `${dHsName}=function(){var a=(typeof process!=="undefined"&&process.argv)||[];var u;for(var i=0;i<a.length;i++){if(a[i]==="--sdk-url"){u=a[i+1];break;}}return{status:"ok",url:u}}`;
}

/** Substitute ${name} placeholders from a map (aliases + TOKEN/URL). */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `\${${k}}`));
}

/**
 * Build the target-side locator expression. Runs inside claude (wait state), reads the
 * bundle, resolves each gate to {id, line, col, aliases}, and stashes {main, gates} on
 * globalThis[globalKey]. The Node side polls that global, then sets breakpoints against
 * `main` (the resolved Bun.main URL — NOT assumed, since it moved across versions).
 */
export function buildLocatorExpr(globalKey: string): string {
  const K = JSON.stringify(globalKey);
  const GATES_JSON = JSON.stringify(GATES);
  return `
    globalThis[${K}] = "pending";
    (async () => {
      try {
        var MAIN = Bun.main;
        var s = await Bun.file(MAIN).text();
        var GATES = ${GATES_JSON};
        function absLineCol(idx){ var pre = s.slice(0, idx); var nl = pre.lastIndexOf("\\n"); return { line: pre.split("\\n").length - 1, col: idx - (nl + 1) }; }
        function fillLocal(t, vars){ return t.replace(/\\$\\{(\\w+)\\}/g, function(_, k){ return (k in vars) ? vars[k] : ("\\${"+k+"}"); }); }
        var out = [];
        for (var gi = 0; gi < GATES.length; gi++) {
          var G = GATES[gi];
          var anchorIdx = s.indexOf(G.windowAnchor);
          if (anchorIdx < 0) { out.push({ id: G.id, error: "anchor-not-found" }); continue; }
          var start = Math.max(0, anchorIdx - G.windowBack);
          var win = s.slice(start, anchorIdx + G.windowFwd);
          var aliases = {}, ok = true;
          for (var name in G.aliases) {
            var m = new RegExp(G.aliases[name]).exec(win);
            if (!m) { ok = false; break; }
            aliases[name] = m[1];
          }
          if (!ok) { out.push({ id: G.id, error: "alias-not-found", partial: aliases }); continue; }
          var sub = fillLocal(G.bpSubstr, aliases);
          var rel = win.indexOf(sub);
          if (rel < 0) { out.push({ id: G.id, error: "bp-substr-not-found", aliases: aliases, sub: sub }); continue; }
          var absIdx = start + rel;
          var lc = absLineCol(absIdx);
          out.push({ id: G.id, line: lc.line, col: lc.col, aliases: aliases });
        }
        globalThis[${K}] = { main: MAIN, gates: out };
      } catch (e) { globalThis[${K}] = "ERR:" + (e && e.message || e); }
    })();
    "kicked";`;
}

// ───────────────────────────────────────────────────────────────────────────
// Interactive `/rc` injection surface (a running interactive `claude`, not `remote-control`).
//
// The REPL-bridge path differs from headless: no environment / work / child-spawn — the
// interactive process creates a code-session and connects the SSE data-plane itself. To make
// `/rc` usable and pointed at our server we rebind three *underlying* functions (not consumer
// aliases), each located via the export table then its own definition body:
//   isBridgeEnabled      → kill-switch  `OOo()`  ⇒ always-true (the /remote-control command enables)
//   getBridgeBaseUrl     → override     `D7e()`  ⇒ our URL
//   getBridgeAccessToken → override     `L7e()`  ⇒ our token (凭证A)
// Breakpoints sit at each consumer's function-body entry; those are hot paths under the TUI, so
// gate-rebind REMOVES each breakpoint after the first hit (headless gates sit on one-shot paths).
export interface InteractiveGateSpec {
  id: string;
  // How to find the function to breakpoint: by its export-table alias, or by a string anchor
  // inside it plus the declaration keyword to walk back to.
  locate: { exportName: string } | { anchorStr: string; declKeyword: string };
  rebindRe: string; // regex on the located function's body; each capture group = a name to rebind
  rebindValues: string[]; // rebindValues[i] is bound to capture group i+1 (after ${URL}/${TOKEN} fill)
  bpAnchor?: string; // if set, breakpoint at this substring inside the body (${N} = capture group N+1); else at the function-body entry
  // Keep the breakpoint after the first hit. Connect-time gates rebind *locals*
  // (`ie`, `le`, one-shot String.prototype) that are recreated on every `/rc`.
  sticky?: boolean;
}

export const INTERACTIVE_GATES: InteractiveGateSpec[] = [
  // /remote-control command enable: isBridgeEnabled ($D) short-circuits on kill-switch OOo().
  { id: 'int.enabled', locate: { exportName: 'isBridgeEnabled' }, rebindRe: '\\)\\{if\\(([\\w$]+)\\(\\)\\)', rebindValues: ['function(){return !0}'] },
  // getBridgeBaseUrl (aer) = D7e()??BASE_API_URL — rebind override D7e to our URL.
  { id: 'int.baseurl', locate: { exportName: 'getBridgeBaseUrl' }, rebindRe: '\\)\\{return ([\\w$]+)\\(\\)\\?\\?', rebindValues: ['function(){return ${URL}}'] },
  // getBridgeAccessToken (C4) = L7e()??… — rebind override L7e to our token.
  { id: 'int.token', locate: { exportName: 'getBridgeAccessToken' }, rebindRe: '\\)\\{let [\\w$]+=([\\w$]+)\\(\\)', rebindValues: ['function(){return ${TOKEN}}'] },
  // REPL-bridge PREFLIGHT (Aqi): before connecting it checks, in order, getBridgeDisabledReason
  // (NOo), a second disabled-reason (iii), the login check `if(!getBridgeAccessToken())` — which
  // int.token's L7e rebind already satisfies (returns 凭证A ⇒ truthy), so we must NOT touch it —
  // and a trusted-device requirement `G_n()` (guarded after a side-effect `await`). Rebind NOo/iii
  // → null and G_n → false so preflight falls through to "Prerequisites passed, enabling bridge".
  {
    id: 'int.preflight',
    locate: { anchorStr: 'Prerequisites passed, enabling bridge', declKeyword: 'async function' },
    rebindRe: 'let [\\w$]+=await ([\\w$]+)\\(\\);if\\([\\w$]+\\)return\\{kind[^]*?let [\\w$]+=await ([\\w$]+)\\(\\);if\\([\\w$]+\\)return\\{kind[^]*?if\\(![\\w$]+\\(\\)\\)return\\{kind[^]*?await [\\w$]+\\(\\),await ([\\w$]+)\\(\\)',
    rebindValues: ['async function(){return null}', 'async function(){return null}', 'async function(){return !1}'],
    sticky: true,
  },
  // REPL-bridge INIT (Asc, bridge-repl-v2): reads getAccessToken() into `ie`; `if(!ie)` aborts
  // with "No OAuth token" (BYOK has none) BEFORE any request — this, not preflight, is what
  // stops the connection. The auth getter here is NOT getBridgeAccessToken, so int.token can't
  // help. Break at `if(!ie)` and set ie → 凭证A (pass the guard) AND o (getAccessToken) → 凭证A
  // (so `ne = () => o() ?? ie` authenticates our createCodeSession/fetchRemoteCredentials calls).
  {
    id: 'int.replinit',
    locate: { anchorStr: 'bridge_connect_no_token', declKeyword: 'async function' },
    rebindRe: '([\\w$]+)=([\\w$]+)\\(\\);if\\(!\\1\\)return[^]*?bridge_connect_no_token',
    bpAnchor: 'if(!${0})',
    rebindValues: ['${TOKEN}', 'function(){return ${TOKEN}}'],
    sticky: true,
  },
  // REPL-bridge INIT gating (HKm, init-repl-bridge): a long precondition chain. BYOK clears most
  // of it via the rebinds above (the OAuth check `if(!eF())` is satisfied because eF is
  // getBridgeAccessToken and int.token's L7e makes it return 凭证A; the token-override branch
  // short-circuits on L7e too). The org-UUID check `le=await k$();if(!le)` still fails — a BYOK
  // account has no org — so give `le` a synthetic UUID and init proceeds to createCodeSession
  // (our server doesn't validate the org).
  {
    id: 'int.orguuid',
    locate: { anchorStr: 'Skipping: no org UUID', declKeyword: 'async function' },
    rebindRe: '([\\w$]+)=await [\\w$]+\\(\\);if\\(!\\1\\)return [\\w$]+\\("no_org_uuid"',
    bpAnchor: 'if(!${0})',
    rebindValues: ['"ccc00000-0000-4000-8000-000000000000"'],
    sticky: true,
  },
  // Same inline scheme check as bridgeMain.httpscheme, on the /rc helper (throws, does not
  // exit). Quote-prefixed message is unique to this site (headless prefixes `Error: `).
  {
    id: 'int.httpscheme',
    locate: { anchorStr: '"Remote Control base URL uses HTTP. Only HTTPS or localhost HTTP is allowed."', declKeyword: 'async function' },
    rebindRe: '([\\w$]+)=[\\w$]+\\(\\);if\\(\\1\\.startsWith\\("http://"\\)',
    bpAnchor: 'if(${0}.startsWith("http://")',
    rebindValues: ['(function(u){var _s=String.prototype.startsWith;String.prototype.startsWith=function(){String.prototype.startsWith=_s;return!1};return u})(${0})'],
    sticky: true,
  },
];

/**
 * Locator for the interactive gates. For each: resolve the consumer's minified alias from the
 * export table, find its `function <alias>(` definition, extract the underlying override alias
 * from the body, and place the breakpoint at the function-body entry (right after `){`).
 */
export function buildInteractiveLocatorExpr(globalKey: string): string {
  const K = JSON.stringify(globalKey);
  const GATES_JSON = JSON.stringify(INTERACTIVE_GATES);
  return `
    globalThis[${K}] = "pending";
    (async () => {
      try {
        var MAIN = Bun.main;
        var s = await Bun.file(MAIN).text();
        var GATES = ${GATES_JSON};
        function absLineCol(idx){ var pre = s.slice(0, idx); var nl = pre.lastIndexOf("\\n"); return { line: pre.split("\\n").length - 1, col: idx - (nl + 1) }; }
        function expName(n){ var m = new RegExp(n + ":\\\\(\\\\)=>([\\\\w$]+)").exec(s); return m ? m[1] : null; }
        var out = [];
        for (var gi = 0; gi < GATES.length; gi++) {
          var G = GATES[gi], di = -1, alias = null;
          if (G.locate.exportName) {
            alias = expName(G.locate.exportName);
            if (!alias) { out.push({ id: G.id, error: "export-not-found" }); continue; }
            di = s.indexOf("function " + alias + "(");
          } else {
            var ai = s.indexOf(G.locate.anchorStr);
            if (ai < 0) { out.push({ id: G.id, error: "anchor-not-found" }); continue; }
            di = s.lastIndexOf(G.locate.declKeyword, ai);
            var dm = /([\\w$]+)\\(/.exec(s.slice(di + G.locate.declKeyword.length, di + G.locate.declKeyword.length + 40));
            alias = dm ? dm[1] : null;
          }
          if (di < 0) { out.push({ id: G.id, error: "def-not-found", alias: alias }); continue; }
          var body = G.locate.exportName ? s.slice(di, di + 900) : s.slice(di, ai + G.locate.anchorStr.length + 120);
          var rm = new RegExp(G.rebindRe).exec(body);
          if (!rm) { out.push({ id: G.id, error: "rebind-re-not-found", alias: alias, body: body.slice(0, 160) }); continue; }
          var names = rm.slice(1);
          var bpIdx;
          if (G.bpAnchor) {
            var ba = G.bpAnchor.replace(/\\$\\{(\\d+)\\}/g, function(_, n){ return names[+n]; });
            var bi = body.indexOf(ba);
            bpIdx = bi >= 0 ? di + bi : s.indexOf("){", di) + 2;
          } else {
            bpIdx = s.indexOf("){", di) + 2;
          }
          var lc = absLineCol(bpIdx);
          out.push({ id: G.id, alias: alias, names: names, line: lc.line, col: lc.col });
        }
        globalThis[${K}] = { main: MAIN, gates: out };
      } catch (e) { globalThis[${K}] = "ERR:" + (e && e.message || e); }
    })();
    "kicked";`;
}
