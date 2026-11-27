import type { ErrorRequestHandler, NextFunction, Request, Response } from "express"
import type pino from "pino"
import logger, { extractSafeError, getRequestId } from "../config/logger.js"

interface HttpLikeError extends Error {
    status?: unknown
    statusCode?: unknown
    module?: unknown
}

export const createErrorLoggerMiddleware = (baseLogger: pino.Logger = logger): ErrorRequestHandler => {
    return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
        if (!res.locals.__errorLogged) {
            const requestId = req.requestId ?? (req.id ? String(req.id) : undefined) ?? getRequestId()
            const errorObj = err as Partial<HttpLikeError> | null
            const moduleName =
                errorObj && typeof errorObj.module === "string" && errorObj.module.trim()
                    ? errorObj.module
                    : "http"

            const safeError = extractSafeError(err)

            baseLogger.error(
                {
                    module: moduleName,
                    event: "http.request.error",
                    ...(requestId ? { requestId } : {}),
                    method: req.method,
                    url: req.originalUrl || req.url,
                    err: err instanceof Error ? err : new Error(safeError.message),
                },
                safeError.message || "Unhandled request error",
            )

            res.locals.__errorLogged = true
        }

        next(err)
    }
}

export const errorLoggerMiddleware: ErrorRequestHandler = createErrorLoggerMiddleware()

export const globalErrorHandler: ErrorRequestHandler = (
    err: unknown,
    _req: Request,
    res: Response,
    next: NextFunction,
): void => {
    if (res.headersSent) {
        next(err)
        return
    }

    const errorObj = err as Partial<HttpLikeError> | null
    const rawStatus =
        typeof errorObj?.statusCode === "number"
            ? errorObj.statusCode
            : typeof errorObj?.status === "number"
              ? errorObj.status
              : 500

    const statusCode = rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500
    const safeMessage =
        statusCode < 500 && err instanceof Error && err.message
            ? err.message
            : "Internal server error"

    res.status(statusCode).json({
        status: "failed",
        message: safeMessage,
    })
}
