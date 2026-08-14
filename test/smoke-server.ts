/**
 * smoke-server.ts — throwaway controller server for the interactive `/rc` smoke test.
 * Logs every non-http ServerEvent + periodic session snapshots to /tmp/ccc-smoke-server.log.
 * Run: node test/smoke-server.ts   (port 8790, credential 'smoke-cred')
 */
import { createControllerServer } from '../src/server/index.ts';
import { attachWebChannel } from '../src/server/web-channel.ts';
import fs from 'node:fs';

const LOG = '/tmp/ccc-smoke-server.log';
const ts = () => new Date().toISOString().slice(11, 23);
const log = (m: string) => { try { fs.appendFileSync(LOG, `${ts()} ${m}\n`); } catch {} };
fs.writeFileSync(LOG, '');

let web: any = null;
const server = await createControllerServer({
  port: 8790,
  host: '127.0.0.1',
  onEvent: (e: any) => { log(e.type === 'http' ? `HTTP ${e.method} ${e.path}` : `EVENT ${JSON.stringify(e).slice(0, 300)}`); web?.handleEvent(e); },
});
web = attachWebChannel(server.server, server, server.store);
log('server up on 8790');
setInterval(() => {
  const ss = server.store.sessionsForCredential('smoke-cred').map((s: any) => ({ id: s.id, m: s.machineName, dir: s.dir, ws: s.wsConnected }));
  if (ss.length) log(`SESSIONS ${JSON.stringify(ss)}`);
}, 2000);
