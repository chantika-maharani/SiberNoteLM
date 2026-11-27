import { AsyncLocalStorage } from "node:async_hooks"
import fs from "node:fs"
import path from "node:path"
import pino from "pino"
import type { DestinationStream, Logger, LoggerOptions, TransportTargetOptions } from "pino"
import envVariable from "../utils/ENV.js"

export interface RequestLogContext {
    requestId: string
}

export const requestContextStorage = new AsyncLocalStorage<RequestLogContext>()

export const getRequestId = (): string | undefined => requestContextStorage.getStore()?.requestId

export const SERVICE_NAME = "sibernote-backend"

const SENSITIVE_FIELDS = [
    "password",
    "oldPassword",
    "newPassword",
    "accessToken",
    "refreshToken",
    "token",
    "authorization",
    "cookie",
    "apiKey",
    "api_key",
    "apiSecret",
    "api_secret",
    "credentials",
    "secret",
    "jwt",
    "GEMINI_EMBEDDING_KEY",
    "GEMINI_MODEL",
    "GEMINI_MODEL_Flashcard",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
    "MONGO_URL",
    "JWT_KEY",
    "REFRESH_TOKEN_KEY",
]

const buildRedactPaths = (): string[] => {
    const paths = new Set<string>([
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
        "headers.authorization",
        "headers.cookie",
        'headers["set-cookie"]',
        'headers["x-api-key"]',
        '["set-cookie"]',
        '*["set-cookie"]',
        '*.*["set-cookie"]',
    ])

    for (const field of SENSITIVE_FIELDS) {
        paths.add(field)
        paths.add(`*.${field}`)
        paths.add(`*.*.${field}`)
        paths.add(`*.*.*.${field}`)
    }

    return Array.from(paths)
}

export const REDACT_PATHS = buildRedactPaths()

export interface CreateLoggerOptions {
    level?: string
    environment?: string
    logDir?: string
    logToFile?: boolean
    infoRetentionDays?: number
    errorRetentionDays?: number
    maxFileSize?: string
    destination?: DestinationStream
}

const isLogDirWritable = (logDir: string): boolean => {
    try {
        fs.mkdirSync(logDir, { recursive: true })
        fs.accessSync(logDir, fs.constants.W_OK)
        const probeFile = path.join(logDir, `.write-probe-${process.pid}`)
        const fd = fs.openSync(probeFile, "a")
        fs.closeSync(fd)
        fs.unlinkSync(probeFile)
        return true
    } catch {
        return false
    }
}

export const sanitizeErrorMessage = (message: string): string =>
    message
        .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi, "$1[REDACTED]")
        .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED]")
        .replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)[^@]+(@)/gi, "$1[REDACTED]$2")

export interface SafeErrorInfo {
    name: string
    message: string
    stack?: string
    errorCategory: string
    providerStatus?: number
    code?: string
}

export const extractSafeError = (err: unknown): SafeErrorInfo => {
    if (err instanceof Error) {
        const record = err as Error & {
            status?: unknown
            statusCode?: unknown
            code?: unknown
        }
        const rawStatus =
            typeof record.status === "number"
                ? record.status
                : typeof record.statusCode === "number"
                  ? record.statusCode
                  : undefined
        const code = typeof record.code === "string" ? record.code : undefined
        const message = sanitizeErrorMessage(err.message)

        let errorCategory = err.name || "Error"
        if (rawStatus === 429 || message.includes("429") || message.toLowerCase().includes("quota")) {
            errorCategory = "rate_limit"
        } else if (rawStatus === 503 || message.includes("503")) {
            errorCategory = "provider_unavailable"
        } else if (rawStatus !== undefined && rawStatus >= 400 && rawStatus < 500) {
            errorCategory = "client_error"
        } else if (rawStatus !== undefined && rawStatus >= 500) {
            errorCategory = "server_error"
        }

        const safe: SafeErrorInfo = {
            name: err.name,
            message,
            errorCategory,
        }
        if (err.stack) {
            safe.stack = sanitizeErrorMessage(err.stack)
        }
        if (rawStatus !== undefined) {
            safe.providerStatus = rawStatus
        }
        if (code !== undefined) {
            safe.code = code
        }
        return safe
    }

    return {
        name: "UnknownError",
        message: sanitizeErrorMessage(String(err)),
        errorCategory: "unknown_error",
    }
}

const buildBasePinoOptions = (level: string, environment: string): LoggerOptions => ({
    level,
    base: {
        service: SERVICE_NAME,
        environment,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
        paths: REDACT_PATHS,
        censor: "[REDACTED]",
    },
    serializers: {
        err: (err: unknown) => {
            if (!(err instanceof Error)) return err
            const safe = extractSafeError(err)
            return {
                type: safe.name,
                message: safe.message,
                stack: safe.stack,
                ...(safe.code !== undefined ? { code: safe.code } : {}),
                ...(safe.providerStatus !== undefined ? { status: safe.providerStatus } : {}),
            }
        },
    },
    mixin(_mergeObject: object, _level: number, activeLogger: Logger) {
        const requestId = getRequestId()
        if (!requestId) return {}
        const bindings = activeLogger.bindings()
        if (typeof bindings.requestId === "string" && bindings.requestId.length > 0) {
            return {}
        }
        return { requestId }
    },
})

export const createLogger = (options: CreateLoggerOptions = {}): Logger => {
    const environment = options.environment ?? envVariable.NODE_ENV
    const level = options.level ?? envVariable.LOG_LEVEL
    const logDir = path.resolve(options.logDir ?? envVariable.LOG_DIR)
    const logToFile = options.logToFile ?? envVariable.LOG_TO_FILE
    const infoRetentionDays = options.infoRetentionDays ?? envVariable.LOG_RETENTION_INFO_DAYS
    const errorRetentionDays = options.errorRetentionDays ?? envVariable.LOG_RETENTION_ERROR_DAYS
    const maxFileSize = options.maxFileSize ?? envVariable.LOG_MAX_FILE_SIZE

    const baseOptions = buildBasePinoOptions(level, environment)

    if (options.destination) {
        return pino(baseOptions, options.destination)
    }

    const targets: TransportTargetOptions[] = []

    if (environment !== "production") {
        targets.push({
            target: "pino-pretty",
            level,
            options: {
                colorize: true,
                translateTime: "SYS:standard",
                ignore: "pid,hostname",
            },
        })
    } else {
        targets.push({
            target: "pino/file",
            level,
            options: {
                destination: 1,
            },
        })
    }

    let storageUnavailable = false
    if (logToFile) {
        if (isLogDirWritable(logDir)) {
            targets.push({
                target: "pino-roll",
                level: "info",
                options: {
                    file: path.join(logDir, "app"),
                    frequency: "daily",
                    dateFormat: "yyyy-MM-dd",
                    size: maxFileSize,
                    extension: ".log",
                    mkdir: true,
                    limit: {
                        count: infoRetentionDays,
                        removeOtherLogFiles: true,
                    },
                },
            })
            targets.push({
                target: "pino-roll",
                level: "warn",
                options: {
                    file: path.join(logDir, "error"),
                    frequency: "daily",
                    dateFormat: "yyyy-MM-dd",
                    size: maxFileSize,
                    extension: ".log",
                    mkdir: true,
                    limit: {
                        count: errorRetentionDays,
                        removeOtherLogFiles: true,
                    },
                },
            })
        } else {
            storageUnavailable = true
        }
    }

    try {
        const transport = pino.transport({ targets })
        transport.on("error", (err: Error) => {
            process.stderr.write(
                JSON.stringify({
                    level: 50,
                    time: new Date().toISOString(),
                    service: SERVICE_NAME,
                    environment,
                    module: "logger",
                    event: "logger.transport.error",
                    msg: sanitizeErrorMessage(err.message),
                }) + "\n",
            )
        })

        const instance = pino(baseOptions, transport)
        if (storageUnavailable) {
            instance.warn(
                {
                    module: "logger",
                    event: "logger.storage.unavailable",
                    logDir,
                },
                "Log directory is not writable; falling back to stdout logging only",
            )
        }
        return instance
    } catch (err) {
        const fallback = pino(baseOptions)
        fallback.warn(
            {
                module: "logger",
                event: "logger.transport.fallback",
                err,
            },
            "Failed to initialize Pino transport; using default stdout logger",
        )
        return fallback
    }
}

export const logger: Logger = createLogger()

export const createModuleLogger = (
    moduleName: string,
    bindings?: Record<string, unknown>,
): Logger => {
    const requestId = getRequestId()
    return logger.child({
        module: moduleName,
        ...(requestId && !(bindings && "requestId" in bindings) ? { requestId } : {}),
        ...bindings,
    })
}

export default logger
