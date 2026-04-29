FROM node:18
WORKDIR /app
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    unzip \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgbm-dev \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    libu2f-udev \
    libvulkan1 \
    xvfb \
    ca-certificates \
    git \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*
    
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google-chrome-keyring.gpg \
    && echo 'deb [signed-by=/usr/share/keyrings/google-chrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main' | tee /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable
    
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_CACHE_DIR=/tmp/puppeteer_cache \
    NODE_ENV=production

COPY . /app
RUN npm install string-similarity puppeteer puppeteer-extra puppeteer-extra-plugin-stealth express axios qs cors
RUN npx puppeteer install
npx puppeteer browsers install chrome
EXPOSE 7860
CMD ["node", "app.js"]
