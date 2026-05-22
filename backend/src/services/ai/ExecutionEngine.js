import { logger } from '../../utils/logger.js';

// ExecutionEngine — safe executor for structured AI action requests.
// Only actions registered in ALLOWED_ACTIONS are permitted. Each action handler
// must validate params and enforce permission checks.

const ALLOWED_ACTIONS = new Set(['send_message']);

/**
 * executeAction(contract, context)
 * contract: { action: string, params: object }
 * context: { botInstance, senderJid, senderNumber, isAdmin }
 */
export async function executeAction(contract, context = {}) {
  const { action, params } = contract;
  const { botInstance, senderJid, senderNumber, isAdmin } = context;

  if (!ALLOWED_ACTIONS.has(action)) {
    logger.warn({ action, botId: botInstance?.botId }, 'ExecutionEngine: action not allowed');
    return { ok: false, error: 'action_not_allowed' };
  }

  switch (action) {
    case 'send_message':
      // params expected: { to: 'user'|'number'|'conversation', text: string }
      if (!params || typeof params !== 'object') return { ok: false, error: 'invalid_params' };
      const to = params.to;
      const text = String(params.text ?? '').trim();
      if (!text) return { ok: false, error: 'missing_text' };

      // Allowed recipients: 'user' (the sender), 'number' (explicit phone), 'conversation' (current convo)
      let target = null;
      if (to === 'user') {
        target = senderJid;
      } else if (to === 'number') {
        const number = String(params.number ?? '').replace(/[^\d+]/g, '');
        if (!number) return { ok: false, error: 'missing_number' };
        target = `${number}@s.whatsapp.net`;
      } else if (to === 'conversation') {
        target = params.conversation_jid ?? null;
      } else {
        return { ok: false, error: 'invalid_recipient' };
      }

      if (!target) return { ok: false, error: 'invalid_target' };

      // Admin-only sends? allow if isAdmin true or sponsor flag in bot config
      const adminOnly = Boolean(params.admin_only === true);
      if (adminOnly && !isAdmin) return { ok: false, error: 'permission_denied' };

      try {
        await botInstance.sendMessage(target, { text }, { persist: true });
        return { ok: true };
      } catch (err) {
        logger.error({ err, botId: botInstance?.botId, action }, 'ExecutionEngine: send_message failed');
        return { ok: false, error: 'send_failed' };
      }

    default:
      return { ok: false, error: 'unknown_action' };
  }
}

export default { executeAction };
