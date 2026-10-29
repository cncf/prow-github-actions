FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.core.json ./
COPY src ./src
RUN npm run build && npm run pack:server

FROM node:24-slim
ENV NODE_ENV=production PORT=8080
USER node
WORKDIR /app
COPY --from=build /app/dist-server ./dist-server
EXPOSE 8080
CMD ["node", "dist-server/index.js"]
