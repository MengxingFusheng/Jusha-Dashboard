ARG NODE_IMAGE=node:20-alpine
FROM ${NODE_IMAGE}

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json ./
COPY server.js ./
COPY config ./config
COPY public ./public
COPY data/.gitkeep ./data/.gitkeep

RUN mkdir -p /app/data /app/logs

EXPOSE 3000

CMD ["node", "server.js"]
