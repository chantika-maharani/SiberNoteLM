import mongoose from "mongoose"
import envVariable from "../utils/ENV.js"
import { ensureVectorSearchIndex } from "../models/chunk.model.js"
import { createModuleLogger } from "../config/logger.js"

const dbLogger = createModuleLogger("database")
let listenersRegistered = false

const registerConnectionListeners = (): void => {
    if (listenersRegistered) return
    listenersRegistered = true

    mongoose.connection.on("connected", () => {
        dbLogger.info(
            {
                event: "database.mongodb.connected",
                host: mongoose.connection.host,
                dbName: mongoose.connection.name,
            },
            "MongoDB connected",
        )
    })

    mongoose.connection.on("disconnected", () => {
        dbLogger.warn(
            {
                event: "database.mongodb.disconnected",
            },
            "MongoDB disconnected",
        )
    })

    mongoose.connection.on("error", (err: unknown) => {
        dbLogger.error(
            {
                event: "database.mongodb.connection.failed",
                err,
            },
            "MongoDB connection error",
        )
    })
}

const connectDB = async (): Promise<void> => {
    registerConnectionListeners()
    try {
        await mongoose.connect(envVariable.MONGO_URL)
        await ensureVectorSearchIndex()
    } catch (error) {
        dbLogger.fatal(
            {
                event: "database.mongodb.connection.failed",
                err: error,
            },
            "Failed to connect to MongoDB",
        )
        process.exit(1)
    }
}

export const disconnectDB = async (): Promise<void> => {
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect()
    }
}

export default connectDB
