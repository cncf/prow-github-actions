FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
# the server bundle only; the action and the Worker have their own builds and type checks in CI
RUN npx tsc --noEmit && npm run pack:server

FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
LABEL org.opencontainers.image.source="https://github.com/cncf/prow-github-actions" \
      org.opencontainers.image.description="Prow-style chat-ops for GitHub, as a GitHub App" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production PORT=8080
USER node
WORKDIR /app
COPY --from=build /app/dist-server ./dist-server
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist-server/index.js"]
