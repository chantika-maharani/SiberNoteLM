import path from "path"
import express, { type Request, type Response } from "express"
import swaggerUi from "swagger-ui-express"
import envVariable from "./utils/ENV.js"
import connectDB, { disconnectDB } from "./services/mongo.js"
import userRouter from "./routes/user.route.js"
import notebookRouter from "./routes/notebook.route.js"
import documentRouter from "./routes/document.route.js"
import cors from "cors"
import noteRouter from "./routes/note.route.js"
import chatRouter from "./routes/chat.route.js"
import swaggerSpec from "./swagger.js"
import citationRouter from "./routes/citation.route.js"
import logger, { createModuleLogger } from "./config/logger.js"
import httpLoggerMiddleware from "./middlewares/httpLogger.middleware.js"
import { errorLoggerMiddleware, globalErrorHandler } from "./middlewares/errorLogger.middleware.js"

const serverLogger = createModuleLogger("server")
const app = express()
const PORT = envVariable.PORT

app.use(httpLoggerMiddleware)
app.use(express.json())
app.use(cors())
await connectDB()

// if (!fs.existsSync(envVariable.UPLOADS_DIR)) {
//     fs.mkdirSync(envVariable.UPLOADS_DIR, { recursive: true })
// }

app.use("/uploads", express.static(path.resolve(envVariable.UPLOADS_DIR)))

app.get("/", (_req: Request, res: Response) => {
    res.status(200).json({
        status:"success",
        message:"server healthy"
    })
})

// ── Health Check Endpoint untuk Docker/K8s ────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: envVariable.NODE_ENV
    })
})

app.use("/user", userRouter)
app.use("/notebooks",notebookRouter)
app.use("/documents", documentRouter)
app.use("/notes",noteRouter)
app.use("/chats", chatRouter)
app.use("/citations",citationRouter)
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec))

app.use(errorLoggerMiddleware)
app.use(globalErrorHandler)

const server = app.listen(PORT, () => {
    serverLogger.info(
        {
            event: "server.started",
            port: PORT,
            environment: envVariable.NODE_ENV,
        },
        `Server listening on port ${PORT}`,
    )
})

let isShuttingDown = false
const SHUTDOWN_TIMEOUT_MS = 10_000

const gracefulShutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return
    isShuttingDown = true

    const startedAt = Date.now()
    serverLogger.info(
        {
            event: "server.shutdown.started",
            signal,
            environment: envVariable.NODE_ENV,
        },
        `Graceful shutdown initiated by ${signal}`,
    )

    const forceTimer = setTimeout(() => {
        serverLogger.error(
            {
                event: "server.shutdown.failed",
                signal,
                durationMs: Date.now() - startedAt,
                reason: "shutdown_timeout",
            },
            "Graceful shutdown timed out; forcing exit",
        )
        process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forceTimer.unref()

    try {
        await new Promise<void>((resolve, reject) => {
            server.close((err) => {
                if (err) reject(err)
                else resolve()
            })
        })

        await disconnectDB()

        clearTimeout(forceTimer)
        serverLogger.info(
            {
                event: "server.shutdown.completed",
                signal,
                durationMs: Date.now() - startedAt,
                environment: envVariable.NODE_ENV,
            },
            "Graceful shutdown completed",
        )

        logger.flush()
        process.exit(0)
    } catch (err) {
        clearTimeout(forceTimer)
        serverLogger.error(
            {
                event: "server.shutdown.failed",
                signal,
                durationMs: Date.now() - startedAt,
                err,
            },
            "Graceful shutdown failed",
        )
        logger.flush()
        process.exit(1)
    }
}

process.on("SIGINT", () => {
    void gracefulShutdown("SIGINT")
})

process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM")
})

process.on("unhandledRejection", (reason: unknown) => {
    serverLogger.error(
        {
            event: "server.unhandled_rejection",
            err: reason instanceof Error ? reason : new Error(String(reason)),
        },
        "Unhandled promise rejection",
    )
})

process.on("uncaughtException", (err: Error) => {
    serverLogger.fatal(
        {
            event: "server.uncaught_exception",
            err,
        },
        "Uncaught exception",
    )
    void gracefulShutdown("uncaughtException")
})