import { vi } from "vitest";

const testEnvironment = {
  AI_GATEWAY_API_KEY: "test-ai-gateway-key",
  BETTER_AUTH_SECRET: "test-auth-secret",
  BETTER_AUTH_URL: "https://example.com",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  DECODO_PROXY_URL: "http://user:pass@gate.decodo.com:7000",
  SECRET_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
};

for (const [name, value] of Object.entries(testEnvironment)) {
  vi.stubEnv(name, value);
}
