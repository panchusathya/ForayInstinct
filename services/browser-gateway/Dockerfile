# Build context must be the REPO ROOT: the image needs both the service and
# the shared wire contract at lib/browser/contract.ts.
#
#   fly deploy --config services/browser-gateway/fly.toml \
#     --dockerfile services/browser-gateway/Dockerfile .
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
