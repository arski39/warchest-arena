// [ARENA] new file — logger for the auth service.
//
// Deliberately not `server/Logger.ts`: that module wires OpenTelemetry at
// import time and reaches into ServerEnv, which throws for vars the auth
// service has no business setting (NUM_WORKERS, GIT_COMMIT, TURNSTILE_SITE_KEY).
// The auth service is a separate process in a separate container; coupling it
// to the game server's env contract would mean it could not boot alone.
import winston from "winston";

export const authLogger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ level, message, timestamp, ...rest }) => {
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
      return `${timestamp} [auth] ${level}: ${message}${extra}`;
    }),
  ),
  transports: [new winston.transports.Console()],
});

export type AuthLog = Pick<winston.Logger, "info" | "warn" | "error" | "debug">;
