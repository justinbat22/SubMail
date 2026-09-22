declare module "*.sql?raw" {
  const content: string;
  export default content;
}

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    ATTACHMENTS: R2Bucket;
    EMAIL_DOMAIN: string;
    // Backblaze B2 config. Not used when the ATTACHMENTS binding exists
    // (the local R2 test bucket backs attachment storage in tests); the
    // b2.ts test seam only falls back to B2 when no binding is provided.
    B2_KEY_ID: string;
    B2_APPLICATION_KEY: string;
    B2_REGION: string;
    B2_BUCKET: string;
    APP_URL: string;
    MAILBOX_TTL_HOURS: string;
    MAX_MESSAGE_SIZE: string;
    MAX_ATTACHMENT_SIZE: string;
    MAX_ATTACHMENTS_PER_MESSAGE: string;
    MAX_MESSAGES_PER_MAILBOX: string;
    CLEANUP_BATCH_SIZE: string;
  }
}
