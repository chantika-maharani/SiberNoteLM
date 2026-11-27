import { type Request, type Response, type NextFunction } from "express"
import jwt, { type JwtPayload } from "jsonwebtoken"
import envVariable from "../utils/ENV.js"
import response from "../utils/response.js"
import { createModuleLogger } from "../config/logger.js"

const authLogger = createModuleLogger("auth")

export const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        authLogger.warn(
            {
                event: "auth.token.verification.failed",
                reason: "missing_or_invalid_authorization_header",
                path: req.originalUrl,
            },
            "Token verification failed",
        )
        response.userError(res, "Sesi Anda telah berakhir, silakan login kembali",401)
        return
    }

    const token = authHeader.split(" ")[1]

    if (!token) {
        authLogger.warn(
            {
                event: "auth.token.verification.failed",
                reason: "empty_bearer_token",
                path: req.originalUrl,
            },
            "Token verification failed",
        )
        response.userError(res, "Sesi Anda telah berakhir, silakan login kembali",401)
        return
    }

    try {
        const decoded = jwt.verify(token, envVariable.JWT_KEY) as JwtPayload

        if (typeof decoded.userId !== "string") {
            authLogger.warn(
                {
                    event: "auth.token.verification.failed",
                    reason: "invalid_token_payload",
                    path: req.originalUrl,
                },
                "Token verification failed",
            )
            response.userError(res, "Sesi Anda telah berakhir, silahkan login kembali",401)
            return
        }

        req.userId = decoded.userId
        next()
    } catch (error) {
        authLogger.warn(
            {
                event: "auth.token.verification.failed",
                reason: error instanceof Error ? error.name : "verification_error",
                path: req.originalUrl,
            },
            "Token verification failed",
        )
        response.userError(res, "Sesi Anda telah berakhir, silahkan login kembali",401)
        return
    }
}
