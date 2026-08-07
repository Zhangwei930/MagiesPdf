'use strict';

const { isLoopbackUrl } = require('./openAiClient.cjs');

/**
 * Strict local privacy: nothing about a document may reach a network this app
 * cannot see the other end of.
 *
 * Enforced here rather than in the settings pane, because a toggle that only
 * hides buttons is not a privacy control — the refusal has to sit on the path a
 * turn actually takes. Both paths use it: the built-in model runtime, and a
 * turn handed to a coding-agent CLI.
 *
 * Returns null when the turn may proceed, or a refusal to throw.
 */
function strictPrivacyRefusal({ strict, baseUrl = '', agent = '' }) {
  if (!strict) return null;

  if (String(agent).startsWith('cli:')) {
    return {
      code: 'AI_STRICT_LOCAL_PRIVACY',
      message: 'Strict local privacy forbids handing a turn to an external CLI agent',
      userMessage: {
        zh: '已开启严格本地隐私：命令行 Agent 会用它自己的账号访问云端，本应用无法限制，因此不允许。',
        en: 'Strict local privacy is on: a CLI agent reaches its vendor over its own account, which this app cannot restrict, so the turn is refused.',
      },
    };
  }

  let local = false;
  try {
    local = Boolean(baseUrl) && isLoopbackUrl(baseUrl);
  } catch {
    local = false;
  }
  if (local) return null;

  return {
    code: 'AI_STRICT_LOCAL_PRIVACY',
    message: 'Strict local privacy allows loopback model endpoints only',
    userMessage: {
      zh: '已开启严格本地隐私：只允许使用回环地址的模型接口（如本机 Ollama、LM Studio）。',
      en: 'Strict local privacy is on: only a loopback model endpoint is allowed, such as a local Ollama or LM Studio.',
    },
  };
}

module.exports = { strictPrivacyRefusal };
