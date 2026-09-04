// Public surface of the host-neutral Kiro core.

export { KiroBlockBuffer } from "./blocks.js";
export { parseBracketToolCalls } from "./bracket-tool-parser.js";
export { calculateKiroCost } from "./cost.js";
export { debugEnabled, debugLog, formatSafeError, redactSensitiveText } from "./debug.js";
export {
  buildKiroAdditionalModelRequestFields,
  clampKiroEffort,
  deriveKiroEffort,
  fallbackKiroEffort,
  getKiroEffortConfig,
  type KiroAdditionalModelRequestFields,
  type KiroEffortConfig,
  type KiroEffortField,
  mapEffortToKiroValue,
} from "./effort.js";
export {
  getKiroEndpoints,
  getKiroRegionFromEndpoint,
  type KiroEndpoints,
  resolveApiRegion,
} from "./endpoints.js";
export { type KiroWireEvent, parseKiroEvent } from "./event-parser.js";
export {
  isKiroToolStructureRule,
  KIRO_TOOL_STRUCTURE_RULES,
  KIRO_VALIDATION_MESSAGES,
  type KiroRepairResult,
  type KiroToolStructureRule,
  type KiroValidationError,
  type KiroValidationResult,
  KiroValidationRule,
  kiroConversationEntries,
  repairKiroConversation,
  SYNTHETIC_FAILED_TOOL_RESULT_TEXT,
  validateKiroConversation,
  validateKiroToolStructure,
} from "./history-validator.js";
export { parseInvokeToolCalls } from "./invoke-tool-parser.js";
export {
  getKiroCliCredentials,
  getKiroCliCredentialsAllowExpired,
  getKiroCliDbPath,
  getKiroCliSocialToken,
  getKiroCliSocialTokenAllowExpired,
  refreshViaKiroCli,
  saveKiroCliCredentials,
} from "./kiro-cli.js";
export { getKiroIdeCredentials, getKiroIdeCredentialsAllowExpired } from "./kiro-ide.js";
export {
  fetchKiroModelCatalog,
  type KiroCatalogModel,
  type KiroManagementAuth,
  KiroManagementHttpError,
  resolveKiroProfileArn,
} from "./management.js";
export {
  applyEffortLadder,
  getCachedModels,
  isCacheStale,
  KIRO_MANAGEMENT_CACHE_PATH,
  KIRO_MODEL_IDS,
  type KiroModel,
  kiroModels,
  loadCachedModelIds,
  mapKiroCatalogModels,
  resolveKiroModel,
  updateKiroModelsCache,
} from "./models.js";
export {
  isApiKey,
  isExpired,
  type KiroAuthMethod,
  type KiroCredentials,
  kiroAuthHeaders,
  loginKiroWithApiKey,
  refreshKiroToken,
  resolveKiroCredentials,
} from "./oauth.js";
// Kiro's own error vocabulary and the predicates this core classifies it with.
// Published so consumers can interpret a reason code without an error instance
// in hand (a persisted log line, say) instead of hardcoding copies of the
// literals, which drift when the service adds a code.
export {
  CAPACITY_PATTERN,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
  KIRO_REASON_CODES,
  type KiroReasonCode,
  NON_RETRYABLE_BODY_PATTERNS,
  TOO_BIG_PATTERNS,
} from "./retry.js";
export { type KiroStreamRequest, resetProfileArnCache, streamKiro } from "./stream.js";
export { ThinkingTagParser } from "./thinking-parser.js";
export { countTokens } from "./tokenizer.js";
export {
  buildHistory,
  EMPTY_CONTENT_PLACEHOLDER,
  type KiroHistoryEntry,
  type KiroImage,
  type KiroToolResult,
  type KiroToolSpec,
  type KiroToolUse,
  type KiroUserInputMessage,
  normalizeMessages,
  relocateDisplacedToolResults,
  sanitizeSurrogates,
  toKiroToolUseId,
} from "./transform.js";
export { TRUNCATION_NOTICE, wasPreviousResponseTruncated } from "./truncation.js";
export * from "./types.js";
export { fetchKiroUsage, type KiroProviderUsage, type KiroProviderUsageBucket } from "./usage.js";
