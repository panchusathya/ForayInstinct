import { vi } from "vitest";

const testEnvironment = {
  AI_GATEWAY_API_KEY: "test-ai-gateway-key",
  BETTER_AUTH_SECRET: "test-auth-secret",
  BETTER_AUTH_URL: "https://example.com",
  BROWSERBASE_API_KEY: "test-browserbase-key",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  SECRET_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
};

for (const [name, value] of Object.entries(testEnvironment)) {
  vi.stubEnv(name, value);
}
