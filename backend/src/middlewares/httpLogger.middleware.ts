import crypto from "node:crypto"
import type { NextFunction, Request, RequestHandler, Response } from "express"
import type { IncomingMessage, ServerResponse } from "node:http"
import type pino from "pino"
import { pinoHttp } from "pino-http"
import logger, { requestContextStorage } from "../config/logger.js"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const resolveRequestId = (req: IncomingMessage): string => {
    const headerVal = req.headers["x-request-id"]
    const candidate = Array.isArray(headerVal) ? headerVal[0] : headerVal
    if (typeof candidate === "string" && UUID_REGEX.test(candidate.trim())) {
        return candidate.trim()
    }
    return crypto.randomUUID()
}

export const createHttpLoggerMiddleware = (baseLogger: pino.Logger = logger): RequestHandler => {
    const middleware = pinoHttp<IncomingMessage, ServerResponse>({
        logger: baseLogger,
        genReqId: (req, res) => {
            const requestId = resolveRequestId(req)
            res.setHeader("X-Request-Id", requestId)
            return requestId
        },
        customAttributeKeys: {
            reqId: "requestId",
            responseTime: "responseTime",
        },
        customLogLevel(_req, res, err) {
            if (err || res.statusCode >= 500) return "error"
            if (res.statusCode >= 400) return "warn"
            return "info"
        },
        customProps(_req, _res) {
            return {
                module: "http",
                event: "http.request.completed",
            }
        },
        customSuccessMessage(req, res, responseTime) {
            return `${req.method ?? "UNKNOWN"} ${req.url ?? "/"} ${res.statusCode} (${Math.round(responseTime)}ms)`
        },
        customErrorMessage(req, res, err) {
            return `${req.method ?? "UNKNOWN"} ${req.url ?? "/"} ${res.statusCode} - ${err.message}`
        },
        serializers: {
            req(req: IncomingMessage & { originalUrl?: string }) {
                return {
                    method: req.method,
                    url: req.originalUrl ?? req.url,
                    remoteAddress: req.socket?.remoteAddress,
                    headers: {
                        host: req.headers.host,
                        "user-agent": req.headers["user-agent"],
                        authorization: req.headers.authorization,
                        cookie: req.headers.cookie,
                        "x-api-key": req.headers["x-api-key"],
                    },
                }
            },
            res(res: ServerResponse) {
                return {
                    statusCode: res.statusCode,
                }
            },
        },
    })

    return (req: Request, res: Response, next: NextFunction): void => {
        middleware(req, res, () => {
            const requestId = String(req.id)
            req.requestId = requestId
            requestContextStorage.run({ requestId }, next)
        })
    }
}

export const httpLoggerMiddleware: RequestHandler = createHttpLoggerMiddleware()

export default httpLoggerMiddleware
