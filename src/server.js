import express from "express";
import cors from "cors";
import { assertConfig, config } from "./config.js";
import { closeDatabase, connectToDatabase } from "./db.js";
import applicationsRouter from "./routes/applications.js";
import companiesRouter from "./routes/companies.js";
import jobsRouter from "./routes/jobs.js";
import paymentsRouter from "./routes/payments.js";
import savedJobsRouter from "./routes/savedJobs.js";
import usersRouter from "./routes/users.js";

assertConfig();

const app = express();
let server;

app.use(cors({
  origin: config.clientOrigin,
  credentials: true,
}));
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.json({
    name: "HireLoop API",
    status: "running",
    environment: config.nodeEnv,
  });
});

app.get("/health", async (_req, res, next) => {
  try {
    await connectToDatabase();
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    next(error);
  }
});

app.use("/api/jobs", jobsRouter);
app.use("/api/companies", companiesRouter);
app.use("/api/applications", applicationsRouter);
app.use("/api/saved-jobs", savedJobsRouter);
app.use("/api/users", usersRouter);
app.use("/api/payments", paymentsRouter);

app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.originalUrl} not found` });
});

app.use((error, _req, res, _next) => {
  const isDuplicate = error?.code === 11000;
  const status = isDuplicate ? 409 : 500;
  const message = isDuplicate ? "Duplicate record already exists" : error.message || "Internal server error";

  if (config.nodeEnv !== "test") {
    console.error(error);
  }

  res.status(status).json({ message });
});

async function startServer() {
  try {
    await connectToDatabase();

    server = app.listen(config.port, () => {
      console.log(`HireLoop API running on http://localhost:${config.port}`);
    });

    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(`Port ${config.port} is already in use. Change PORT in .env or stop the other process.`);
        process.exit(1);
      }

      throw error;
    });
  } catch (error) {
    console.error("Failed to start HireLoop API.");
    console.error(`MongoDB connection failed for ${config.mongoUri}`);
    console.error("Start MongoDB locally or set MONGODB_URI in hireloop-server/.env to your MongoDB Atlas connection string.");
    console.error(error.message);
    process.exit(1);
  }
}

async function shutdown() {
  if (!server) {
    await closeDatabase();
    process.exit(0);
  }

  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startServer();