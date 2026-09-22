declare module "*.sql?raw" {
  const content: string;
  export default content;
}

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    ATTACHMENTS: R2Bucket;
    EMAIL_DOMAIN: string;
    APP_URL: string;
    MAILBOX_TTL_HOURS: string;
    MAX_MESSAGE_SIZE: string;
    MAX_ATTACHMENT_SIZE: string;
    MAX_ATTACHMENTS_PER_MESSAGE: string;
    MAX_MESSAGES_PER_MAILBOX: string;
    CLEANUP_BATCH_SIZE: string;
  }
}
