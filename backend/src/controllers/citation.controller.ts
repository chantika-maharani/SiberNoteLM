import type { Request, Response } from "express"
import Message from "../models/message.model.js"
import response from "../utils/response.js"
import { createModuleLogger } from "../config/logger.js"

const citationLogger = createModuleLogger("citation")

export const getCitation = async (req: Request, res: Response) => {
    try {
        const { messageId, citationIndex } = req.params

        if (!messageId || !citationIndex || typeof citationIndex !== "string" || typeof messageId !== "string") {
            return response.userError(res, "messageId atau citationIndex tidak valid")
        }

        const index = parseInt(citationIndex, 10)
        if (isNaN(index) || index < 1) {
            return response.userError(res, "citationIndex tidak valid, harus angka >= 1")
        }

        const message = await Message.findById(messageId).select("citations").lean()

        if (!message) {
            return response.notFoundError(res, "message tidak ditemukan")
        }

        const citation = message.citations.find((c) => c.citationIndex === index)

        if (!citation) {
            return response.notFoundError(res, `citation [${index}] tidak ditemukan di message ini`)
        }
        citationLogger.debug({ event: "citation.fetched", messageId, citationIndex: index }, "Fetched citation")
        return response.requestSuccessWithData(res, "berhasil get citation", { citation }, 200)
    } catch (error) {
        citationLogger.error(
            { event: "citation.fetch.failed", messageId: req.params.messageId, err: error },
            "Failed to fetch citation",
        )
        return response.serverError(res, "gagal get citation")
    }
}
