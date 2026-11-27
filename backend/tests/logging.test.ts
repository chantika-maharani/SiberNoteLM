import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import express from "express"
import mongoose from "mongoose"
import {
    createLogger,
    extractSafeError,
    getRequestId,
    sanitizeErrorMessage,
    SERVICE_NAME,
} from "../src/config/logger.js"
import { createHttpLoggerMiddleware } from "../src/middlewares/httpLogger.middleware.js"
import {
    createErrorLoggerMiddleware,
    globalErrorHandler,
} from "../src/middlewares/errorLogger.middleware.js"
import { chunkTXT } from "../src/services/chunking.js"
import Document from "../src/models/document.model.js"
import Chunk from "../src/models/chunk.model.js"
import TableOfContents from "../src/models/toc.model.js"
import Notebook from "../src/models/notebook.model.js"
import { uploadDocument } from "../src/controllers/document.controller.js"

interface ParsedLog {
    level: number
    time: string
    service: string
    environment: string
    module?: string
    event?: string
    requestId?: string
    msg?: string
    req?: {
        method?: string
        url?: string
        headers?: Record<string, unknown>
    }
    res?: {
        statusCode?: number
    }
    responseTime?: number
    err?: {
        type?: string
        message?: string
        stack?: string
    }
    [key: string]: unknown
}

const createMemoryStream = (): { stream: PassThrough; getLogs: () => ParsedLog[] } => {
    const stream = new PassThrough()
    let buffer = ""
    stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8")
    })
    const getLogs = (): ParsedLog[] =>
        buffer
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line) as ParsedLog)
    return { stream, getLogs }
}

const withServer = async (
    app: express.Express,
    fn: (baseUrl: string) => Promise<void>,
): Promise<void> => {
    const server = http.createServer(app)
    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve())
    })
    const addr = server.address()
    assert.ok(addr && typeof addr !== "string")
    const baseUrl = `http://127.0.0.1:${addr.port}`
    try {
        await fn(baseUrl)
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()))
        })
    }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test("1. Centralized logger produces structured JSON with module context and ISO timestamp", () => {
    const { stream, getLogs } = createMemoryStream()
    const testLogger = createLogger({
        destination: stream,
        environment: "production",
        level: "info",
    })

    const child = testLogger.child({ module: "notebook" })
    child.info({ event: "notebook.created", notebookId: "nb-1", userId: "user-1" }, "Notebook created")

    const logs = getLogs()
    assert.equal(logs.length, 1)
    const entry = logs[0]!
    assert.equal(entry.level, 30)
    assert.equal(entry.service, SERVICE_NAME)
    assert.equal(entry.environment, "production")
    assert.equal(entry.module, "notebook")
    assert.equal(entry.event, "notebook.created")
    assert.equal(entry.notebookId, "nb-1")
    assert.equal(entry.userId, "user-1")
    assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test("2. Sensitive data redaction protects top-level, nested, and error strings", () => {
    const { stream, getLogs } = createMemoryStream()
    const testLogger = createLogger({
        destination: stream,
        environment: "production",
        level: "info",
    })

    testLogger.info(
        {
            password: "plain-password",
            oldPassword: "old-password",
            newPassword: "new-password",
            accessToken: "jwt-access",
            refreshToken: "jwt-refresh",
            token: "opaque-token",
            apiKey: "gemini-secret-key",
            credentials: { secret: "top-secret" },
            req: {
                headers: {
                    authorization: "Bearer super-secret-jwt",
                    cookie: "session=secret-cookie",
                    "x-api-key": "header-api-key",
                },
            },
            res: {
                headers: {
                    "set-cookie": ["sid=123; HttpOnly"],
                },
            },
        },
        "Redaction check",
    )

    const logs = getLogs()
    assert.equal(logs.length, 1)
    const serialized = JSON.stringify(logs[0])
    for (const secret of [
        "plain-password",
        "old-password",
        "new-password",
        "jwt-access",
        "jwt-refresh",
        "opaque-token",
        "gemini-secret-key",
        "top-secret",
        "super-secret-jwt",
        "secret-cookie",
        "header-api-key",
        "sid=123",
    ]) {
        assert.equal(serialized.includes(secret), false, `Secret leaked in log: ${secret}`)
    }

    const sanitized = sanitizeErrorMessage(
        "Request failed to https://example.com?key=AIzaSecret123&foo=1 with Bearer abc.def.ghi and mongodb+srv://admin:pass123@cluster.mongodb.net/db",
    )
    assert.equal(sanitized.includes("AIzaSecret123"), false)
    assert.equal(sanitized.includes("abc.def.ghi"), false)
    assert.equal(sanitized.includes("pass123"), false)

    const errInfo = extractSafeError(Object.assign(new Error("429 quota exceeded"), { status: 429 }))
    assert.equal(errInfo.errorCategory, "rate_limit")
    assert.equal(errInfo.providerStatus, 429)
})

test("3. HTTP logging assigns UUID requestId, exposes it in AsyncLocalStorage, uses right levels, and preserves API responses", async () => {
    const { stream, getLogs } = createMemoryStream()
    const testLogger = createLogger({
        destination: stream,
        environment: "production",
        level: "info",
    })

    const app = express()
    app.use(createHttpLoggerMiddleware(testLogger))

    app.get("/ok", (req, res) => {
        const alsRequestId = getRequestId()
        const svcLogger = testLogger.child({ module: "rag" })
        svcLogger.info({ event: "rag.retrieval.completed", durationMs: 12 }, "Retrieval done")
        res.status(200).json({
            status: "success",
            requestId: req.requestId,
            alsRequestId,
        })
    })

    app.get("/bad", (_req, res) => {
        res.status(400).json({ status: "failed", message: "bad input" })
    })

    app.get("/boom", () => {
        throw new Error("Simulated unhandled crash")
    })

    app.use(createErrorLoggerMiddleware(testLogger))
    app.use(globalErrorHandler)

    await withServer(app, async (baseUrl) => {
        const resOk = await fetch(`${baseUrl}/ok`)
        assert.equal(resOk.status, 200)
        const bodyOk = (await resOk.json()) as {
            status: string
            requestId: string
            alsRequestId: string
        }
        assert.equal(bodyOk.status, "success")
        assert.match(
            bodyOk.requestId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        )
        assert.equal(bodyOk.requestId, bodyOk.alsRequestId)
        assert.equal(resOk.headers.get("x-request-id"), bodyOk.requestId)

        const customUuid = "550e8400-e29b-41d4-a716-446655440000"
        const resBad = await fetch(`${baseUrl}/bad`, {
            headers: { "x-request-id": customUuid },
        })
        assert.equal(resBad.status, 400)
        assert.equal(resBad.headers.get("x-request-id"), customUuid)
        const bodyBad = (await resBad.json()) as { status: string; message: string }
        assert.deepEqual(bodyBad, { status: "failed", message: "bad input" })

        const resBoom = await fetch(`${baseUrl}/boom`)
        assert.equal(resBoom.status, 500)
        const bodyBoom = (await resBoom.json()) as { status: string; message: string }
        assert.deepEqual(bodyBoom, { status: "failed", message: "Internal server error" })
    })

    await wait(50)
    const logs = getLogs()

    const ragLog = logs.find((l) => l.event === "rag.retrieval.completed")
    assert.ok(ragLog)
    assert.ok(ragLog.requestId)
    assert.equal(ragLog.durationMs, 12)

    const http200 = logs.find((l) => l.event === "http.request.completed" && l.res?.statusCode === 200)
    assert.ok(http200)
    assert.equal(http200.level, 30)
    assert.equal(http200.req?.method, "GET")
    assert.equal(http200.req?.url, "/ok")
    assert.equal(typeof http200.responseTime, "number")

    const http400 = logs.find((l) => l.event === "http.request.completed" && l.res?.statusCode === 400)
    assert.ok(http400)
    assert.equal(http400.level, 40)

    const errLogs = logs.filter((l) => l.event === "http.request.error")
    assert.equal(errLogs.length, 1, "Unhandled error should be logged exactly once")
    assert.equal(errLogs[0]!.level, 50)
    assert.equal(errLogs[0]!.err?.message, "Simulated unhandled crash")
    assert.ok(errLogs[0]!.err?.stack?.includes("Simulated unhandled crash"))

    const http500 = logs.find((l) => l.event === "http.request.completed" && l.res?.statusCode === 500)
    assert.ok(http500)
    assert.equal(http500.level, 50)
})

test("4. File persistence and log rotation create JSON files and enforce retention count", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sibernote-logs-"))
    try {
        const fileLogger = createLogger({
            environment: "production",
            level: "info",
            logDir: tempDir,
            logToFile: true,
            infoRetentionDays: 2,
            errorRetentionDays: 2,
            maxFileSize: "1k",
        })

        for (let i = 0; i < 40; i++) {
            fileLogger.info(
                { module: "document", event: "document.chunking.completed", index: i, padding: "x".repeat(120) },
                "Rotating info log entry",
            )
            fileLogger.error(
                { module: "document", event: "document.parse.failed", index: i, padding: "y".repeat(120) },
                "Rotating error log entry",
            )
        }

        // Allow worker thread (pino-roll) to flush & rotate files
        await wait(800)

        const files = fs.readdirSync(tempDir)
        const appFiles = files.filter((f) => f.startsWith("app.") && f.endsWith(".log"))
        const errorFiles = files.filter((f) => f.startsWith("error.") && f.endsWith(".log"))

        assert.ok(appFiles.length >= 1, "Expected rotated app log files to exist")
        assert.ok(appFiles.length <= 3, `Expected retention limit (2 rotated + 1 active), got ${appFiles.length}`)
        assert.ok(errorFiles.length >= 1, "Expected rotated error log files to exist")
        assert.ok(errorFiles.length <= 3, `Expected error retention limit (2 rotated + 1 active), got ${errorFiles.length}`)

        const sampleContent = fs.readFileSync(path.join(tempDir, appFiles[0]!), "utf8")
        const firstLine = sampleContent.split("\n").find((l) => l.trim().length > 0)
        assert.ok(firstLine)
        const parsed = JSON.parse(firstLine) as ParsedLog
        assert.equal(parsed.service, SERVICE_NAME)
        assert.equal(parsed.environment, "production")
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})

test("5. Logger degrades gracefully without crashing when log directory is not writable", () => {
    const invalidLogDir = "/proc/sibernote-cannot-write-logs"
    assert.doesNotThrow(() => {
        const fallbackLogger = createLogger({
            environment: "production",
            level: "info",
            logDir: invalidLogDir,
            logToFile: true,
        })
        fallbackLogger.info({ module: "server", event: "server.started" }, "App remains operational")
    })
})

test("6. Document upload & chunking flow executes normally with logging active", async () => {
    const uploadsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "sibernote-uploads-"))
    const origFindNotebook = Notebook.findOne
    const origExistsDoc = Document.exists
    const origCreateDoc = Document.create
    const origInsertChunks = Chunk.insertMany
    const origUpdateDoc = Document.findByIdAndUpdate
    const origDeleteToc = TableOfContents.deleteOne

    try {
        const fakeNotebookId = new mongoose.Types.ObjectId().toString()
        const fakeDocId = new mongoose.Types.ObjectId()

        ;(Notebook.findOne as unknown) = async () => ({ _id: fakeNotebookId })
        ;(Document.exists as unknown) = async () => null
        ;(Document.create as unknown) = async (payload: Record<string, unknown>) => ({
            _id: fakeDocId,
            ...payload,
            deleteOne: async () => ({}),
        })
        ;(Chunk.insertMany as unknown) = async () => []
        ;(Document.findByIdAndUpdate as unknown) = async () => ({ _id: fakeDocId })
        ;(TableOfContents.deleteOne as unknown) = async () => ({ deletedCount: 0 })

        // Test chunkTXT validation error path without needing network Gemini call
        await assert.rejects(
            () => chunkTXT(Buffer.from("   ", "utf8"), fakeDocId),
            /Tidak ada konten/,
        )

        // Verify uploadDocument validation response contract remains intact
        const req = {
            userId: "user-123",
            requestId: "550e8400-e29b-41d4-a716-446655440001",
            params: { notebookId: fakeNotebookId },
            file: undefined,
        } as unknown as express.Request

        let responseStatus = 0
        let responseBody: unknown = null
        const res = {
            status(code: number) {
                responseStatus = code
                return this
            },
            json(body: unknown) {
                responseBody = body
                return this
            },
        } as unknown as express.Response

        await uploadDocument(req, res)
        assert.equal(responseStatus, 400)
        assert.deepEqual(responseBody, {
            status: "failed",
            message: "file tidak ditemukan, kirim file dengan field name 'file'",
        })
    } finally {
        ;(Notebook.findOne as unknown) = origFindNotebook
        ;(Document.exists as unknown) = origExistsDoc
        ;(Document.create as unknown) = origCreateDoc
        ;(Chunk.insertMany as unknown) = origInsertChunks
        ;(Document.findByIdAndUpdate as unknown) = origUpdateDoc
        ;(TableOfContents.deleteOne as unknown) = origDeleteToc
        fs.rmSync(uploadsTmp, { recursive: true, force: true })
    }
})
