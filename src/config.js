import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 5000),
  nodeEnv: process.env.NODE_ENV || "development",
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
  mongoUri: process.env.MONGODB_URI,
  dbName: process.env.DB_NAME || "hireloop",
};

export function assertConfig() {
  if (!config.mongoUri) {
    throw new Error("MONGODB_URI is required. Add it to hireloop-server/.env");
  }
}