# Builds ONLY the browser gateway (services/browser-gateway) — not the Next.js
# app, which deploys to Vercel via eve. This file lives at the repo root so
# Railway (and any Docker host) picks it up automatically with zero build
# configuration; the build context must be the repo root because the image
# needs both the service and the shared files it imports from lib/browser
# (the wire contract and the registrable-domain rule). When the gateway starts
# importing another shared file, add it to the COPY list below AND to the root
# .dockerignore, or the process dies at boot with ERR_MODULE_NOT_FOUND.
#
# playwright-core only connects over CDP to Brightdata's remote browser, so no
# browser binaries are installed here.
FROM node:24-slim

WORKDIR /app

# The service manifest becomes the image-root manifest so that BOTH the
# service sources (services/browser-gateway/src) and the shared lib/browser
# files resolve their imports from /app/node_modules.
COPY services/browser-gateway/package.json package.json
RUN npm install --omit=dev

COPY lib/browser/contract.ts lib/browser/contract.ts
COPY lib/browser/domains.ts lib/browser/domains.ts
COPY services/browser-gateway/src services/browser-gateway/src

ENV NODE_ENV=production
ENV PORT=8080
# V8 sizes its heap from the memory it can see, which in a container is the
# host's, not the service limit; a heap that grows past the limit is an OOM
# kill with no line in the log. Provisional at 384MB until the Railway service
# memory limit is confirmed (set to roughly 75% of that limit).
ENV NODE_OPTIONS="--max-old-space-size=384"
EXPOSE 8080

# Run the TypeScript directly, matching the repo's node --experimental-strip-types convention.
CMD ["node", "--experimental-strip-types", "services/browser-gateway/src/index.ts"]
