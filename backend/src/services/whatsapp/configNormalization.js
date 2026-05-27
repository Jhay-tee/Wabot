const DEFAULT_REPLY_TIMING = { min_ms: 1_000, max_ms: 12_000 };

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function normalizeSalesAgentConfig(input = {}) {
  const source = typeof input === "object" && input ? input : {};
  const products = Array.isArray(source.products)
    ? source.products
        .map((item) => ({
          name: String(item?.name ?? "").trim().slice(0, 120),
          price: String(item?.price ?? "").trim().slice(0, 40),
          description: String(item?.description ?? "").trim().slice(0, 400),
        }))
        .filter((item) => item.name)
    : [];

  return {
    enabled: Boolean(source.enabled),
    welcome_enabled: Boolean(source.welcome_enabled),
    greeting: String(source.greeting ?? "").trim().slice(0, 1200),
    group_welcome: String(source.group_welcome ?? "").trim().slice(0, 1200),
    show_catalog_on_keyword: source.show_catalog_on_keyword !== false,
    products,
  };
}

export function normalizeKeywordTriggers(input = []) {
  if (!Array.isArray(input)) return [];

  return input
    .map((item) => {
      const matchType = ["contains", "exact", "starts_with", "ends_with", "regex"].includes(item?.matchType)
        ? item.matchType
        : item?.exact_match === true
          ? "exact"
          : "contains";

      return {
        id: item?.id ? String(item.id).slice(0, 80) : undefined,
        keyword: String(item?.keyword ?? "").trim().slice(0, 200),
        response: String(item?.response ?? "").trim().slice(0, 4000),
        matchType,
        caseSensitive: Boolean(item?.caseSensitive),
        enabled: item?.enabled !== false,
      };
    })
    .filter((item) => item.keyword && item.response);
}

export function normalizeCommandsConfig(input = {}) {
  const source = typeof input === "object" && input ? { ...input } : {};
  const timing = source.reply_timing ?? {};

  const reply_timing = {
    min_ms: clampInt(timing.min_ms, 0, 120_000, DEFAULT_REPLY_TIMING.min_ms),
    max_ms: clampInt(timing.max_ms, 0, 120_000, DEFAULT_REPLY_TIMING.max_ms),
  };

  if (reply_timing.min_ms > reply_timing.max_ms) {
    const swap = reply_timing.min_ms;
    reply_timing.min_ms = reply_timing.max_ms;
    reply_timing.max_ms = swap;
  }

  const normalized = { reply_timing };

  for (const [key, value] of Object.entries(source)) {
    if (key === "reply_timing") continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;

    normalized[key] = {
      enabled: value.enabled !== false,
      custom_response: String(value.custom_response ?? "").trim().slice(0, 4000),
    };
  }

  return normalized;
}

export function normalizeGroupManagementConfig(input = {}) {
  const source = typeof input === "object" && input ? input : {};
  const antiVulgarWords = Array.isArray(source.anti_vulgar?.words)
    ? [...new Set(source.anti_vulgar.words.map((word) => String(word ?? "").trim().toLowerCase()).filter(Boolean))]
    : [];

  const normalizeAction = (value) => (value === "kick" ? "kick" : "warn");

  return {
    anti_link: {
      enabled: Boolean(source.anti_link?.enabled),
      action: normalizeAction(source.anti_link?.action),
    },
    anti_spam: {
      enabled: Boolean(source.anti_spam?.enabled),
      threshold: clampInt(source.anti_spam?.threshold, 2, 50, 5),
      window_seconds: clampInt(source.anti_spam?.window_seconds, 3, 60, 10),
      action: normalizeAction(source.anti_spam?.action),
    },
    anti_vulgar: {
      enabled: Boolean(source.anti_vulgar?.enabled),
      words: antiVulgarWords,
      action: normalizeAction(source.anti_vulgar?.action),
    },
    auto_help_on_first_dm: Boolean(source.auto_help_on_first_dm),
    rules: String(source.rules ?? "").trim().slice(0, 3000),
  };
}

export function normalizeAiConfig(input = {}) {
  const source = typeof input === "object" && input ? { ...input } : {};
  const triggerPrefix = String(source.trigger_prefix ?? "@bot").trim().slice(0, 60) || "@bot";
  const assistantAdminNumbers = Array.isArray(source.assistant_admin_numbers)
    ? [...new Set(source.assistant_admin_numbers.map((value) => String(value ?? "").replace(/[^\d]/g, "")).filter(Boolean))]
    : [];
  const assistantName = String(source.assistant_name ?? "Medara").trim().slice(0, 80) || "Medara";

  return {
    ...source,
    enabled: Boolean(source.enabled),
    dm_enabled: source.dm_enabled !== false,
    groups_enabled: Boolean(source.groups_enabled),
    provider: String(source.provider ?? "openai").trim().toLowerCase(),
    model: String(source.model ?? "").trim().slice(0, 120),
    trigger_prefix: triggerPrefix,
    dm_trigger_mode: ["all", "keyword", "mention"].includes(source.dm_trigger_mode) ? source.dm_trigger_mode : "all",
    group_trigger_mode: ["all", "keyword", "mention"].includes(source.group_trigger_mode) ? source.group_trigger_mode : "mention",
    system_prompt: String(source.system_prompt ?? "").trim().slice(0, 6000),
    group_system_prompt: String(source.group_system_prompt ?? "").trim().slice(0, 6000),
    conversation_memory_enabled: source.conversation_memory_enabled !== false,
    memory_message_limit: clampInt(source.memory_message_limit, 0, 12, 6),
    memory_char_limit: clampInt(source.memory_char_limit, 0, 6000, 1200),
    summary_char_limit: clampInt(source.summary_char_limit, 0, 4000, 1200),
    assistant_enabled: Boolean(source.assistant_enabled),
    assistant_name: assistantName,
    assistant_admin_numbers: assistantAdminNumbers,
    is_sensitive: Boolean(source.is_sensitive),
    has_key: Boolean(source.has_key || source.encrypted_key),
  };
}

export function normalizeRuntimeBotConfig(input = {}) {
  const source = typeof input === "object" && input ? input : {};

  return {
    plan_tier: source.plan_tier === "paid" ? "paid" : "free",
    bot_type: ["dm", "group", "all"].includes(source.bot_type) ? source.bot_type : "dm",
    auto_reply_enabled: Boolean(source.auto_reply_enabled),
    auto_reply_message: String(source.auto_reply_message ?? "").trim().slice(0, 4000),
    webhook_url: source.webhook_url ? String(source.webhook_url).trim() : null,
    webhook_secret: source.webhook_secret ? String(source.webhook_secret).trim().slice(0, 300) : null,
    website_url: source.website_url ? String(source.website_url).trim() : null,
    catalog_unavail_msg: source.catalog_unavail_msg ? String(source.catalog_unavail_msg).trim().slice(0, 1200) : null,
    messages_this_month: clampInt(source.messages_this_month, 0, 1_000_000_000, 0),
    keyword_triggers: normalizeKeywordTriggers(source.keyword_triggers),
    sales_agent_config: normalizeSalesAgentConfig(source.sales_agent_config),
    commands_config: normalizeCommandsConfig(source.commands_config),
    ai_config: normalizeAiConfig(source.ai_config),
    group_management_config: normalizeGroupManagementConfig(source.group_management_config),
  };
}

export function normalizeRuntimeBotConfigPatch(input = {}) {
  const source = typeof input === "object" && input ? input : {};
  const patch = {};

  if ("plan_tier" in source) patch.plan_tier = source.plan_tier === "paid" ? "paid" : "free";
  if ("bot_type" in source) patch.bot_type = ["dm", "group", "all"].includes(source.bot_type) ? source.bot_type : "dm";
  if ("auto_reply_enabled" in source) patch.auto_reply_enabled = Boolean(source.auto_reply_enabled);
  if ("auto_reply_message" in source) patch.auto_reply_message = String(source.auto_reply_message ?? "").trim().slice(0, 4000);
  if ("webhook_url" in source) patch.webhook_url = source.webhook_url ? String(source.webhook_url).trim() : null;
  if ("webhook_secret" in source) patch.webhook_secret = source.webhook_secret ? String(source.webhook_secret).trim().slice(0, 300) : null;
  if ("website_url" in source) patch.website_url = source.website_url ? String(source.website_url).trim() : null;
  if ("catalog_unavail_msg" in source) patch.catalog_unavail_msg = source.catalog_unavail_msg ? String(source.catalog_unavail_msg).trim().slice(0, 1200) : null;
  if ("messages_this_month" in source) patch.messages_this_month = clampInt(source.messages_this_month, 0, 1_000_000_000, 0);
  if ("keyword_triggers" in source) patch.keyword_triggers = normalizeKeywordTriggers(source.keyword_triggers);
  if ("sales_agent_config" in source) patch.sales_agent_config = normalizeSalesAgentConfig(source.sales_agent_config);
  if ("commands_config" in source) patch.commands_config = normalizeCommandsConfig(source.commands_config);
  if ("ai_config" in source) patch.ai_config = normalizeAiConfig(source.ai_config);
  if ("group_management_config" in source) patch.group_management_config = normalizeGroupManagementConfig(source.group_management_config);

  return patch;
}
