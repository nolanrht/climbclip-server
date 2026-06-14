FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip curl \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    build-essential pkg-config \
    && pip3 install yt-dlp --break-system-packages \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
