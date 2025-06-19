import "dotenv/config";
import express from "express";
import cors from "cors";
import { processDeployment } from "./builder";

const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Build endpoint
app.post("/build", async (req, res) => {
  try {
    const { deploymentId, sourceZipUrl, buildCommand, outputDir } = req.body;

    // Validate required fields
    if (!deploymentId || !sourceZipUrl || !buildCommand || !outputDir) {
      return res.status(400).json({
        success: false,
        error:
          "Missing required fields: deploymentId, sourceZipUrl, buildCommand, outputDir",
      });
    }

    // Validate authorization
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.BUILD_SERVICE_TOKEN || "default-token";

    console.log("=== authHeader", authHeader?.slice(7));
    console.log("=== expectedToken", expectedToken);

    if (
      !authHeader ||
      !authHeader.startsWith("Bearer ") ||
      authHeader.slice(7) !== expectedToken
    ) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
    }

    // Generate job ID
    const jobId = `build_${deploymentId}_${Date.now()}`;

    // Start build process asynchronously
    processDeployment({
      deploymentId,
      sourceZipUrl,
      buildCommand,
      outputDir,
      jobId,
    }).catch((error) => {
      console.error("Build process error:", error);
    });

    // Return immediately with job ID
    res.json({
      success: true,
      jobId,
      message: "Build started",
    });
  } catch (error) {
    console.error("Build endpoint error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

// Error handling middleware
app.use(
  (
    error: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error("Unhandled error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
);

// Start server
app.listen(port, () => {
  console.log(`Build service listening on port ${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
});
