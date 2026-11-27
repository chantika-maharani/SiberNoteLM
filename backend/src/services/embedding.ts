import { GoogleGenerativeAI, TaskType } from "@google/generative-ai"
import envVariable from "../utils/ENV.js"
import { createModuleLogger, extractSafeError } from "../config/logger.js"

const embeddingLogger = createModuleLogger("embedding")

const EMBEDDING_MODEL = "gemini-embedding-001"
export const EMBEDDING_DIMENSIONS = 3072

const BATCH_SIZE = 20
const BATCH_DELAY_MS = 15_000
const RETRY_DELAY_MS = 65_000
const MAX_RETRIES = 2

const genAI = new GoogleGenerativeAI(envVariable.GEMINI_EMBEDDING_KEY)
const embeddingModel = genAI.getGenerativeModel({ model: EMBEDDING_MODEL })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const is429 = (err: unknown): boolean => {
    if (typeof err !== "object" || err === null) return false
    const msg = (err as { message?: string }).message ?? ""
    return msg.includes("429") || msg.toLowerCase().includes("quota")
}

const embedBatchWithRetry = async (texts: string[], attempt = 0): Promise<number[][]> => {
    try {
        const requests = texts.map((text) => ({
            content: { role: "user", parts: [{ text }] },
            taskType: TaskType.RETRIEVAL_DOCUMENT,
        }))

        const result = await embeddingModel.batchEmbedContents({ requests })
        return result.embeddings.map((e) => e.values)
    } catch (err) {
        if (is429(err) && attempt < MAX_RETRIES) {
            embeddingLogger.warn(
                {
                    event: "ai.embedding.rate_limited",
                    model: EMBEDDING_MODEL,
                    attempt: attempt + 1,
                    maxRetries: MAX_RETRIES,
                    retryDelayMs: RETRY_DELAY_MS,
                },
                "Embedding 429 rate limit hit; retrying",
            )
            await sleep(RETRY_DELAY_MS)
            return embedBatchWithRetry(texts, attempt + 1)
        }
        throw err
    }
}

export const generateEmbeddings = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return []

    const startedAt = Date.now()
    const totalBatches = Math.ceil(texts.length / BATCH_SIZE)
    embeddingLogger.info(
        {
            event: "ai.embedding.started",
            model: EMBEDDING_MODEL,
            taskType: "RETRIEVAL_DOCUMENT",
            inputCount: texts.length,
            totalBatches,
        },
        "Document embedding generation started",
    )

    try {
        const allEmbeddings: number[][] = []

        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
            const batch = texts.slice(i, i + BATCH_SIZE)

            embeddingLogger.debug(
                {
                    event: "ai.embedding.batch",
                    model: EMBEDDING_MODEL,
                    batchIndex: Math.floor(i / BATCH_SIZE) + 1,
                    totalBatches,
                    inputCount: batch.length,
                },
                "Processing embedding batch",
            )

            const embeddings = await embedBatchWithRetry(batch)
            allEmbeddings.push(...embeddings)

            if (i + BATCH_SIZE < texts.length) {
                await sleep(BATCH_DELAY_MS)
            }
        }

        embeddingLogger.info(
            {
                event: "ai.embedding.completed",
                model: EMBEDDING_MODEL,
                taskType: "RETRIEVAL_DOCUMENT",
                inputCount: texts.length,
                outputCount: allEmbeddings.length,
                outputDimensions: allEmbeddings[0]?.length ?? EMBEDDING_DIMENSIONS,
                durationMs: Date.now() - startedAt,
            },
            "Document embedding generation completed",
        )

        return allEmbeddings
    } catch (err) {
        const safeErr = extractSafeError(err)
        embeddingLogger.error(
            {
                event: "ai.embedding.failed",
                model: EMBEDDING_MODEL,
                taskType: "RETRIEVAL_DOCUMENT",
                inputCount: texts.length,
                durationMs: Date.now() - startedAt,
                errorCategory: safeErr.errorCategory,
                ...(safeErr.providerStatus !== undefined ? { providerStatus: safeErr.providerStatus } : {}),
                err,
            },
            "Document embedding generation failed",
        )
        throw err
    }
}

export const generateQueryEmbedding = async (text: string): Promise<number[]> => {
    const startedAt = Date.now()
    embeddingLogger.info(
        {
            event: "ai.embedding.started",
            model: EMBEDDING_MODEL,
            taskType: "RETRIEVAL_QUERY",
            inputCount: 1,
        },
        "Query embedding generation started",
    )

    try {
        const result = await embeddingModel.embedContent({
            content: { role: "user", parts: [{ text }] },
            taskType: TaskType.RETRIEVAL_QUERY,
        })

        const values = result.embedding.values
        embeddingLogger.info(
            {
                event: "ai.embedding.completed",
                model: EMBEDDING_MODEL,
                taskType: "RETRIEVAL_QUERY",
                inputCount: 1,
                outputDimensions: values.length,
                durationMs: Date.now() - startedAt,
            },
            "Query embedding generation completed",
        )

        return values
    } catch (err) {
        const safeErr = extractSafeError(err)
        embeddingLogger.error(
            {
                event: "ai.embedding.failed",
                model: EMBEDDING_MODEL,
                taskType: "RETRIEVAL_QUERY",
                inputCount: 1,
                durationMs: Date.now() - startedAt,
                errorCategory: safeErr.errorCategory,
                ...(safeErr.providerStatus !== undefined ? { providerStatus: safeErr.providerStatus } : {}),
                err,
            },
            "Query embedding generation failed",
        )
        throw err
    }
}
