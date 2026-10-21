import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 5000),
  nodeEnv: process.env.NODE_ENV || "development",
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
  mongoUri: process.env.MONGODB_URI,
  dbName: process.env.DB_NAME || "hireloop",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  emailFrom: process.env.EMAIL_FROM || "HireLoop <notifications@hireloop.dev>",
  resendApiKey: process.env.RESEND_API_KEY || "",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpSecure: process.env.SMTP_SECURE === "true",
};

export function assertConfig() {
  if (!config.mongoUri) {
    throw new Error("MONGODB_URI is required. Add it to hireloop-server/.env");
  }
}