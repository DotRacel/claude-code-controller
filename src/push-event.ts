/**
 * Official Remote Control injects a synthetic PushNotification when the REPL
 * bridge hits `connected` (`writeSdkMessages([Fju(bHh, sessionId)])`):
 *
 *   { type:'assistant', is_meta:true, message:{ stop_reason:'tool_use',
 *     content:[{ type:'tool_use', name:'PushNotification',
 *               input:{ message:'Your Claude Code session is ready — continue from your phone anytime.',
 *                       status:'proactive' }}] } }
 *
 * The PushNotification tool also emits a sibling data-plane event:
 *   { type:'os_notification', message, notificationType:'push_notification' }
 */

export const RC_READY_PUSH = 'Your Claude Code session is ready — continue from your phone anytime.';

export interface PushNote {
  message: string;
  status?: string;
  ready: boolean;
}

export function pushNotificationFrom(payload: any): PushNote | null {
  if (!payload || typeof payload !== 'object') return null;
  const t = payload.type;
  if (t === 'os_notification' || (t === 'system' && payload.subtype === 'os_notification')) {
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) return null;
    const status = payload.notificationType || payload.notification_type;
    return { message, status: typeof status === 'string' ? status : undefined, ready: message === RC_READY_PUSH };
  }
  if (t === 'assistant') {
    for (const b of payload.message?.content || []) {
      if (b?.type === 'tool_use' && b.name === 'PushNotification' && typeof b.input?.message === 'string') {
        const message = b.input.message.trim();
        if (!message) continue;
        return { message, status: typeof b.input.status === 'string' ? b.input.status : undefined, ready: message === RC_READY_PUSH };
      }
    }
  }
  return null;
}

export function isPushNotificationToolUse(block: any): boolean {
  return !!block && block.type === 'tool_use' && block.name === 'PushNotification';
}
