FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production PORT=4000 DATABASE_FILE=/data/clinic.db
VOLUME /data
EXPOSE 4000
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "src/server.js"]
