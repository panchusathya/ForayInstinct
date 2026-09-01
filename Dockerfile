# Builds ONLY the browser gateway (services/browser-gateway) — not the Next.js
# app, which deploys to Vercel via eve. This file lives at the repo root so
# Railway (and any Docker host) picks it up automatically with zero build
# configuration; the build context must be the repo root because the image
# needs both the service and the shared wire contract at
# lib/browser/contract.ts.
#
# playwright-core only connects over CDP to Brightdata's remote browser, so no
# browser binaries are installed here.
FROM node:24-slim

WORKDIR /app

# The service manifest becomes the image-root manifest so that BOTH the
# service sources (services/browser-gateway/src) and the shared contract
# (lib/browser/contract.ts) resolve their imports from /app/node_modules.
COPY services/browser-gateway/package.json package.json
RUN npm install --omit=dev

COPY lib/browser/contract.ts lib/browser/contract.ts
COPY services/browser-gateway/src services/browser-gateway/src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Run the TypeScript directly, matching the repo's node --experimental-strip-types convention.
CMD ["node", "--experimental-strip-types", "services/browser-gateway/src/index.ts"]
