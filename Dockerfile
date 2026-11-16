FROM node:22-slim

# Install system utilities needed for building native sqlite bindings
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for Docker layer caching
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Build the client SPA into dist/
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=./data

EXPOSE 3000

CMD ["npm", "start"]
