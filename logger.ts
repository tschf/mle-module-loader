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

export function forcedInfo(message: string){
  const existingLevel = logger.level;
  logger.level = "info";
  logger.info(message);
  logger.level = existingLevel;
}