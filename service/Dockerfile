# The render daemon. The web build comes in as the "web" build context:
#   docker build --build-context web=build/web-<ref> -t anytype-render:<ref> service
# The Playwright image and the playwright package must stay on the same version.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY --from=web / /web
ENV WEB_ROOT=/web NODE_ENV=production
USER pwuser
CMD ["node", "src/server.mjs"]
