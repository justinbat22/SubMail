import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: ["DB"],
          // Local R2 test bucket: attachment storage runs through the b2.ts
          // test seam against this binding, so tests need no B2 credentials
          // and no network. Production has no such binding and uses B2.
          r2Buckets: ["ATTACHMENTS"],
          // Non-secret B2 placeholders — required by Env typing; unused as
          // long as the ATTACHMENTS test binding exists.
          bindings: { B2_KEY_ID: "test-key-id", B2_APPLICATION_KEY: "test-key", B2_REGION: "us-east-005", B2_BUCKET: "tempmail-attachments" },
        },
      },
    },
  },
});
