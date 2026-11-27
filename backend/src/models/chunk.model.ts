import mongoose, { Schema, Types } from "mongoose"
import { EMBEDDING_DIMENSIONS } from "../services/embedding.js"
import { createModuleLogger } from "../config/logger.js"

const dbLogger = createModuleLogger("database")

interface IChunk {
    documentId: Types.ObjectId
    chunkIndex: number
    content: string
    pageStart: number
    pageEnd: number
    embedding: number[]
}

const chunkSchema = new mongoose.Schema<IChunk>(
    {
        documentId: {
            type: Schema.Types.ObjectId,
            ref: "Document",
            required: true,
        },
        chunkIndex: {
            type: Number,
            required: true,
        },
        content: {
            type: String,
            required: true,
        },
        pageStart: {
            type: Number,
            required: true,
        },
        pageEnd: {
            type: Number,
            required: true,
        },
        embedding: {
            type: [Number],
            default: [],
        },
    },
    {
        timestamps: true,
    }
)

chunkSchema.index({ content: "text" })
chunkSchema.index({ documentId: 1, chunkIndex: 1 })

const Chunk = mongoose.model<IChunk>("Chunk", chunkSchema)

export default Chunk

export const ensureVectorSearchIndex = async (): Promise<void> => {
    try {
        const db = mongoose.connection.db
        if (!db) return

        await db.command({
            createSearchIndexes: "chunks",
            indexes: [
                {
                    name: "chunks_vector_index",
                    type: "vectorSearch",
                    definition: {
                        fields: [
                            {
                                type: "vector",
                                path: "embedding",
                                numDimensions: EMBEDDING_DIMENSIONS,
                                similarity: "cosine",
                            },
                            {
                                type: "filter",
                                path: "documentId",
                            },
                        ],
                    },
                },
            ],
        })

        dbLogger.info(
            { event: "database.mongodb.vector_index.created", indexName: "chunks_vector_index" },
            "Vector search index 'chunks_vector_index' created",
        )
    } catch (error: unknown) {
        if (
            typeof error === "object" &&
            error !== null &&
            "codeName" in error &&
            (error as { codeName: string }).codeName === "IndexAlreadyExists"
        ) {
            dbLogger.debug(
                { event: "database.mongodb.vector_index.exists", indexName: "chunks_vector_index" },
                "Vector search index already exists, skipping",
            )
            return
        }
        dbLogger.warn(
            { event: "database.mongodb.vector_index.failed", err: error },
            "Failed to ensure vector search index",
        )
    }
}
