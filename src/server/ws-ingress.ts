/**
 * ws-ingress.ts — server side of the session_ingress WebSocket.
 *
 * The spawned child claude connects here (via `--sdk-url ws://…/v2/session_ingress/ws/<id>`)
 * and speaks stream-json (SDK control protocol). First version: accept the RFC6455 upgrade,
 * decode inbound (masked) text frames, and surface them as events. `send()` (unmasked) is
 * provided for the second version's bidirectional relay.
 */
import crypto from 'node:crypto';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key: string): string {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

export interface IngressConnection {
  sessionId: string;
  send: (text: string) => void;
  close: () => void;
}

/**
 * Attach a session_ingress WS handler to an http server. Path:
 *   /{v1|v2}/session_ingress/ws/<sessionId>
 * Emits: 'connect'(sessionId, conn), 'message'(sessionId, text), 'close'(sessionId).
 */
export class IngressServer extends EventEmitter {
  constructor(server: Server) {
    super();
    server.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket as Duplex, head as Buffer));
  }

  private _onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const u = req.url || '';
    // 2.1.231 CCR v2 data-plane: /v1/code/sessions/<id>/worker/events/stream
    // Older session_ingress: /{v1|v2}/session_ingress/ws/<id>
    const mCode = /\/v1\/code\/sessions\/([^/?]+)\/worker\/events\/stream/.exec(u);
    const mIngress = /\/(?:v1|v2)\/session_ingress\/ws\/([^/?]+)/.exec(u);
    const key = req.headers['sec-websocket-key'];
    const sessionId = mCode ? decodeURIComponent(mCode[1]) : mIngress ? decodeURIComponent(mIngress[1]) : null;
    if (!sessionId || typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );

    const conn: IngressConnection = {
      sessionId,
      send: (text: string) => this._sendFrame(socket, text),
      close: () => { try { socket.end(); } catch {} },
    };

    let buf: Buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    const msgParts: Buffer[] = [];
    let msgOpcode = 0;

    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = this._takeFrame(buf);
        if (!frame) break;
        buf = frame.rest;
        if (frame.opcode === 0x8) { this._sendClose(socket); return; }
        if (frame.opcode === 0x9) { this._sendPong(socket, frame.payload); continue; }
        if (frame.opcode === 0xa) continue;
        if (frame.opcode !== 0x0) msgOpcode = frame.opcode;
        msgParts.push(frame.payload);
        if (frame.fin) {
          const full = msgParts.length === 1 ? msgParts[0] : Buffer.concat(msgParts);
          msgParts.length = 0;
          if (msgOpcode === 0x1) {
            const text = full.toString('utf8');
            for (const line of text.split('\n')) if (line.trim()) this.emit('message', sessionId, line);
          }
        }
      }
    });
    const done = () => { this.emit('close', sessionId); };
    socket.on('close', done);
    socket.on('error', done);

    this.emit('connect', sessionId, conn);
  }

  /** Decode one client→server (masked) frame from the front of `b`; null if incomplete. */
  private _takeFrame(b: Buffer): { fin: boolean; opcode: number; payload: Buffer; rest: Buffer } | null {
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
    let mask: Buffer | null = null;
    if (masked) { if (b.length < off + 4) return null; mask = b.subarray(off, off + 4); off += 4; }
    if (b.length < off + len) return null;
    let payload = b.subarray(off, off + len);
    if (mask) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    return { fin, opcode, payload, rest: b.subarray(off + len) };
  }

  private _sendFrame(socket: Duplex, text: string): void {
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header: Buffer;
    if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
    else if (len < 0x10000) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x81; // FIN + text
    try { socket.write(Buffer.concat([header, payload])); } catch {}
  }

  private _sendPong(socket: Duplex, payload: Buffer): void {
    const header = Buffer.from([0x8a, payload.length & 0x7f]);
    try { socket.write(Buffer.concat([header, payload])); } catch {}
  }

  private _sendClose(socket: Duplex): void {
    try { socket.write(Buffer.from([0x88, 0x00])); socket.end(); } catch {}
  }
}
