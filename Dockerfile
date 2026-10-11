# 编译产物与 CPU 架构无关；在构建机架构运行 esbuild，避开模拟执行的 Go 并发故障。
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/migrations ./server/migrations
COPY --from=build /app/apps/field-wars/dist ./apps/field-wars/dist
USER node
EXPOSE 3000
CMD ["node", "dist/server/main.js"]
