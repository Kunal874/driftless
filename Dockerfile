# The Driftless connector (T10.2). No build step: Node runs the TypeScript sources directly (type stripping).
FROM node:24.18.0-alpine
WORKDIR /app
# Dependencies first, so editing src/ doesn't re-run the install. Only runtime ones: types and tests stay out.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
# The local-dev config. Use your own by mounting it over this file, or set DRIFTLESS_CONFIG; PG*, MEILI_HOST and
# MEILI_MASTER_KEY override it (README → Configuration).
COPY driftless.config.json ./
USER node
EXPOSE 9464
CMD ["node", "src/main.ts"]
