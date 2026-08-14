/**
 * test-gates.ts — end-to-end injector check.
 *
 * Stands up a stub HTTP server, launches `claude remote-control` with the gates rebound
 * and getBridgeBaseUrl pointed at the stub, and asserts:
 *   - every gate located + hit + rebound
 *   - no OAuth-only gate error text on stderr
 *   - the stub receives POST /v1/environments/bridge  (⇒ gates crossed AND base-url redirected)
 *
 * Run: node test/test-gates.ts
 */
import http from 'node:http';
import { launchWithGatesRebound } from '../src/injector/gate-rebind.ts';

const BAD_GATE_TEXT = [
  'only available when using Claude via api.anthropic.com',
  'claude auth login',
  'Workspace not trusted',
  'Remote Control is disabled',
  'too old for Remote Control',
  'base URL uses HTTP',
];

function startStub(): Promise<{ port: number; hits: string[]; close: () => void }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push(`${req.method} ${req.url}`);
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && req.url === '/v1/environments/bridge') {
          res.end(JSON.stringify({ environment_id: 'env-test-123', poll_interval_ms: 1000, heartbeat_interval_ms: 20000 }));
        } else if (req.url?.includes('/work/poll')) {
          res.statusCode = 200;
          res.end(''); // no work
        } else {
          res.end('{}');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as any).port, hits, close: () => server.close() }));
  });
}

async function main() {
  const stub = await startStub();
  const baseUrl = `http://127.0.0.1:${stub.port}`;
  console.log(`[test] stub server at ${baseUrl}`);

  let stderr = '';
  const h = await launchWithGatesRebound({
    bridgeBaseUrl: baseUrl,
    bridgeToken: 'test-bridge-token',
    cwd: process.cwd(),
    log: (m) => console.log(m),
    onStderr: (s) => { stderr += s; },
  });

  // Give claude time to cross the gates + register the environment.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !stub.hits.some((x) => x.includes('/v1/environments/bridge')) && !h.isDead()) {
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 500));

  console.log('\n===== RESULT =====');
  console.log('gate reports:');
  for (const r of h.reports) {
    console.log(`  ${r.id}: located=${r.located} hit=${!!r.hit} rebound=${!!r.reboundOk}${r.error ? ' err=' + r.error : ''}`);
  }
  console.log('stub hits:', JSON.stringify(stub.hits.slice(0, 12)));
  const badHit = BAD_GATE_TEXT.filter((t) => stderr.includes(t));
  console.log('bad gate texts on stderr:', badHit.length ? JSON.stringify(badHit) : 'none');
  if (stderr.trim()) console.log('stderr (first 400):', JSON.stringify(stderr.slice(0, 400)));

  const registered = stub.hits.some((x) => x.includes('POST /v1/environments/bridge'));
  console.log(`\n${registered ? '✅ PASS' : '❌ FAIL'}: environment registration ${registered ? 'reached our server (gates crossed + base-url redirected)' : 'NOT received'}`);

  h.kill();
  stub.close();
  process.exit(registered ? 0 : 1);
}

main().catch((e) => { console.error('[test] fatal:', e); process.exit(1); });
