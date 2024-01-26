import { createLogger, format, transports } from "winston";

const logMessage = ( { level, message } ) => {
  return `[${level}]: ${message}`;
};

const Format = format.combine(
  // transformation of data. Idea from: https://snyk.io/advisor/npm-package/winston/functions/winston.format.colorize
  format(info => {
    info.level = info.level.toUpperCase();

    return info;
  })(),
  format.colorize(),
  format.printf(logMessage),
);

export const logger = createLogger({
  level: 'warn',
  format: Format,
  transports: [new transports.Console()]
});

// forcedInfo function is log an `info` message, regardless of the current level
// that is configured. If level is configured to `warn` - info messages won't log
// to the screen. But there are cases where there is useful info you want to show.
export function forcedInfo(message: string){
  const existingLevel = logger.level;
  logger.level = "info";
  logger.info(message);
  logger.level = existingLevel;
}