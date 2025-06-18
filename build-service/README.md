# Build Service

A containerized build service for the Web Hosting Platform that processes user-uploaded source code, builds it, and returns the built assets.

## Features

- **Multi-package manager support**: Automatically detects and uses npm, yarn, or pnpm
- **Secure sandboxed builds**: Each build runs in an isolated environment
- **Webhook notifications**: Sends build results back to the main platform
- **Build logging**: Comprehensive logs for debugging
- **Timeout protection**: Prevents runaway builds
- **Docker containerized**: Easy deployment to Google Cloud Run or any container platform

## Architecture

```
User uploads zip → Supabase Function → Build Service → Webhook → IC Deployment
```

## Environment Variables

- `PORT`: Server port (default: 8080)
- `BUILD_SERVICE_TOKEN`: Authentication token for webhook security
- `NODE_ENV`: Environment (development/production)
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase service role key (for uploading built assets)

## Local Development

```bash
cd build-service
npm install

# Create .env file for local development
cat > .env << 'EOF'
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_ROLE_KEY=your_local_supabase_service_role_key
BUILD_SERVICE_TOKEN=local-dev-token
PORT=8080
NODE_ENV=development
EOF

npm run dev
```

**Important:** Never commit the `.env` file to version control. It's already included in `.gitignore`.

## Building

```bash
npm run build
```

## Docker

```bash
# Build image
docker build -t build-service .

# Run container
docker run -p 8080:8080 \
  -e BUILD_SERVICE_TOKEN=your-secret-token \
  -e SUPABASE_URL=your-supabase-url \
  -e SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-key \
  build-service
```

## Google Cloud Run Deployment

```bash
# Build and push to Google Container Registry
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/build-service

# Deploy to Cloud Run
gcloud run deploy build-service \
  --image gcr.io/YOUR_PROJECT_ID/build-service \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars BUILD_SERVICE_TOKEN=your-secret-token,SUPABASE_URL=your-supabase-url,SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-key \
  --memory 2Gi \
  --cpu 2 \
  --timeout 900 \
  --concurrency 10
```

## API Endpoints

### POST /build

Starts a build process for the provided source code.

**Request:**
```json
{
  "deploymentId": "uuid",
  "sourceZipUrl": "https://...",
  "buildCommand": "npm run build",
  "outputDir": "dist",
  "webhookUrl": "https://..."
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "build_uuid_timestamp",
  "message": "Build started"
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Build Process

1. **Download**: Fetches source zip from provided URL
2. **Extract**: Extracts zip to temporary directory
3. **Detect**: Identifies package manager (npm/yarn/pnpm)
4. **Install**: Installs dependencies
5. **Build**: Runs the specified build command
6. **Package**: Creates zip of built assets
7. **Upload**: Uploads built assets to Supabase Storage
8. **Notify**: Sends webhook with results including storage URL
9. **Cleanup**: Removes temporary files

## Security

- Non-root user execution
- Isolated build environments
- Token-based authentication
- Resource limits and timeouts
- Input validation

## Monitoring

- Health check endpoint for load balancers
- Comprehensive logging
- Build duration tracking
- Error reporting via webhooks

## Supported Build Tools

- Node.js projects (npm, yarn, pnpm)
- Static site generators (Next.js, Vite, Create React App, etc.)
- Any project with a custom build command

## Limitations

- 100MB source code limit
- 10-minute build timeout
- Linux-based builds only
- No GPU acceleration