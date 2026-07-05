# Neuly — API server + frontend in one container.
# Run the scheduler as a second container from the same image:
#   docker run ... neuly npm run schedule
FROM node:22-slim

WORKDIR /app

# Install dependencies first for layer caching
COPY crawlers/package.json crawlers/package-lock.json ./crawlers/
RUN cd crawlers && npm ci

# App code: server + crawlers, the frontend, and vendored JS libraries
COPY crawlers ./crawlers
COPY index.html ./
COPY vendor ./vendor

WORKDIR /app/crawlers

ENV NODE_ENV=production
EXPOSE 3001

# Applies the (idempotent) schema, seeds only if the database is empty,
# then starts the API server which also serves the frontend.
CMD ["npm", "run", "deploy:start"]
