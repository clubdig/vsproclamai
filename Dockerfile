FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p data/songs data/stems data/models

EXPOSE 3000

CMD ["node", "server.js"]
