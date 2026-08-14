/**
 * main.ts — the controller server process entry.
 *   PORT (default 8787), HOST (default 0.0.0.0 so a phone on the LAN can reach it).
 * Wires the bridge control-plane + data-plane (index.ts) to the browser channel
 * (web-channel.ts) and serves the SPA build (web/dist).
 *
 * Run: node src/server/main.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControllerServer, type ServerEvent } from './index.ts';
import { attachWebChannel } from './web-channel.ts';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(here, '../../web/dist');
const ts = () => new Date().toISOString().slice(11, 23);
const short = (c?: string) => (c ? c.slice(0, 8) + '…' : '?');

async function main() {
  let web: ReturnType<typeof attachWebChannel> | null = null;

  const server = await createControllerServer({
    port: PORT,
    host: HOST,
    staticDir,
    onEvent: (e: ServerEvent) => {
      web?.handleEvent(e);
      if (e.type === 'env.register') console.log(`${ts()} env.register cred=${short(e.credential)} env=${e.envId} machine=${e.body?.machine_name ?? '?'} dir=${e.body?.directory ?? '?'}`);
      else if (e.type === 'session.create') console.log(`${ts()} session.create cred=${short(e.credential)} ses=${e.sessionId}`);
      else if (e.type === 'ws.connect') console.log(`${ts()} session online ses=${e.sessionId}`);
      else if (e.type === 'ws.close') console.log(`${ts()} session offline ses=${e.sessionId}`);
      else if (e.type === 'env.deregister') console.log(`${ts()} env.deregister env=${e.envId}`);
    },
  });

  web = attachWebChannel(server.server, server, server.store);

  const hasBuild = fs.existsSync(path.join(staticDir, 'index.html'));
  console.log(`${ts()} controller server listening on http://${HOST}:${PORT}`);
  console.log(`${ts()} static SPA: ${hasBuild ? staticDir : 'NOT BUILT — run the web build (cd web && npm run build)'}`);
  console.log(`${ts()} injector connects with: control-claude-code --server http://<this-host>:${PORT} --credential <凭证A>`);
}

main().catch((e) => { console.error('[server] fatal:', e); process.exit(1); });
