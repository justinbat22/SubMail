/**
 * Cloudflare Worker environment bindings and configuration.
 * Mirrors the [vars] and [[d1_databases]] entries in wrangler.toml.
 *
 * Attachment object storage is Backblaze B2 (S3-Compatible API) rather than
 * the previous native R2 binding — B2 credentials/endpoint are provided as
 * environment variables (the secrets via [secrets]/`wrangler secret put`,
 * see src/lib/b2.ts).
 */
export interface Env {
  // Bindings
  DB: D1Database;
  /**
   * OPTIONAL R2-compatible binding used only as a local/test seam by
   * src/lib/b2.ts: when present (e.g. the vitest-pool-workers suite's
   * Miniflare R2 bucket), attachment storage goes through it so tests stay
   * offline and deterministic. In production this binding is absent and
   * attachments are stored in Backblaze B2 via the S3-Compatible API (see
   * B2_* configuration below).
   */
  ATTACHMENTS?: R2Bucket;

  // Configuration (all strings — Workers env vars are always strings)
  EMAIL_DOMAIN: string;
  APP_URL: string;
  MAILBOX_TTL_HOURS: string;
  MAX_MESSAGE_SIZE: string;
  MAX_ATTACHMENT_SIZE: string;
  MAX_ATTACHMENTS_PER_MESSAGE: string;
  MAX_MESSAGES_PER_MAILBOX: string;
  CLEANUP_BATCH_SIZE: string;

  // Backblaze B2 attachment storage (see src/lib/b2.ts)
  B2_KEY_ID: string;
  B2_APPLICATION_KEY: string;
  B2_REGION: string;
  B2_BUCKET: string;
}

/** Strongly-typed, parsed view of Env's numeric configuration. */
export interface AppConfig {
  emailDomain: string;
  appUrl: string;
  mailboxTtlHours: number;
  maxMessageSize: number;
  maxAttachmentSize: number;
  maxAttachmentsPerMessage: number;
  maxMessagesPerMailbox: number;
  cleanupBatchSize: number;
}

export function loadConfig(env: Env): AppConfig {
  return {
    emailDomain: env.EMAIL_DOMAIN,
    appUrl: env.APP_URL,
    mailboxTtlHours: Number(env.MAILBOX_TTL_HOURS),
    maxMessageSize: Number(env.MAX_MESSAGE_SIZE),
    maxAttachmentSize: Number(env.MAX_ATTACHMENT_SIZE),
    maxAttachmentsPerMessage: Number(env.MAX_ATTACHMENTS_PER_MESSAGE),
    maxMessagesPerMailbox: Number(env.MAX_MESSAGES_PER_MAILBOX),
    cleanupBatchSize: Number(env.CLEANUP_BATCH_SIZE),
  };
}

// ---------------------------------------------------------------------------
// Database row shapes (mirror migrations/0001_initial.sql)
// ---------------------------------------------------------------------------

export interface MailboxRow {
  id: string;
  local_part: string;
  domain: string;
  address: string;
  token_hash: string;
  created_at: number;
  last_activity_at: number;
  expires_at: number;
}

export interface MessageRow {
  id: string;
  mailbox_id: string;
  message_id: string | null;
  sender_name: string | null;
  sender_address: string | null;
  recipient_address: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  created_at: number;
  size_bytes: number;
  has_attachments: number;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  // Historical column name — holds the opaque B2 object key (previously an
  // R2 key; the schema is unchanged, and keys are random in either case).
  r2_key: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export type ApiErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_MAILBOX"
  | "MAILBOX_NOT_FOUND"
  | "MESSAGE_NOT_FOUND"
  | "ATTACHMENT_NOT_FOUND"
  | "NAME_UNAVAILABLE"
  | "RESERVED_NAME"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "DATABASE_ERROR"
  | "STORAGE_ERROR"
  | "PARSE_ERROR"
  | "INTERNAL_ERROR";

/** Public-facing mailbox shape returned to the client. Never includes token_hash. */
export interface MailboxDto {
  id: string;
  address: string;
  createdAt: number;
}

/** Mailbox creation response — the only time the raw token is ever transmitted. */
export interface MailboxCreatedDto extends MailboxDto {
  token: string;
}

export interface MessageSummaryDto {
  id: string;
  senderName: string | null;
  senderAddress: string | null;
  subject: string | null;
  createdAt: number;
  hasAttachments: boolean;
  sizeBytes: number;
}

export interface MessageDetailDto extends MessageSummaryDto {
  recipientAddress: string | null;
  textBody: string | null;
  htmlBody: string | null;
  attachments: AttachmentDto[];
}

export interface AttachmentDto {
  id: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Username generator
// ---------------------------------------------------------------------------

export type UsernamePattern =
  | "first.last.####"
  | "last.first.####"
  | "first##.####"
  | "last.####"
  | "first.last####";

export interface UsernameGeneratorOptions {
  /** Override the default pattern probability distribution (must sum to 1, +/- epsilon). */
  patternWeights?: Partial<Record<UsernamePattern, number>>;
  /** Maximum local-part length to enforce (defaults to 64, the RFC 5321 local-part limit). */
  maxLength?: number;
}
