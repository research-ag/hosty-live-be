# Use Node.js 18 LTS as base image
FROM node:18-alpine

# Install system dependencies for building
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    bash \
    curl

# Install global package managers
RUN npm install -g pnpm

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build the application
RUN npm run build

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S buildservice -u 1001

# Change ownership of the app directory
RUN chown -R buildservice:nodejs /app
RUN chown -R buildservice:nodejs /tmp

# Switch to non-root user
USER buildservice

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Start the application
CMD ["npm", "start"]