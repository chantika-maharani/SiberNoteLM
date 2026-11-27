import type { Request, Response } from "express"
import mongoose from "mongoose"
import response from "../utils/response.js"
import Document from "../models/document.model.js"
import TableOfContents from "../models/toc.model.js"
import { generateToc } from "../services/toc.js"
import type { TocDocument } from "../services/toc.js"
import { createModuleLogger } from "../config/logger.js"

const tocLogger = createModuleLogger("toc")

const getReadyDocuments = async (notebookId: string): Promise<TocDocument[]> => {
    const docs = await Document.find({ notebookId, parseStatus: "done" })
        .select("_id title totalPages")
        .lean()

    return docs.map((d) => ({
        documentId: d._id,
        documentTitle: d.title,
        totalPages: d.totalPages,
    }))
}

const doGenerate = async (notebookId: string): Promise<InstanceType<typeof TableOfContents>> => {
    const docs = await getReadyDocuments(notebookId)

    if (docs.length === 0) {
        throw new Error("422")
    }
    const startedAt = Date.now()
    const chapters = await generateToc(docs)
    const notebookObjectId = new mongoose.Types.ObjectId(notebookId)

    const toc = await TableOfContents.findOneAndUpdate(
        { notebookId: notebookObjectId },
        {
            notebookId: notebookObjectId,
            chapters,
            generatedAt: new Date(),
        },
        { upsert: true, new: true },
    )

    if (!toc) throw new Error("Gagal menyimpan ToC")

    tocLogger.info(
        {
            event: "toc.generation.completed",
            notebookId,
            documentCount: docs.length,
            chaptersCount: chapters.length,
            durationMs: Date.now() - startedAt,
        },
        "Table of contents generated",
    )

    return toc
}


export const getToc = async (req: Request, res: Response) => {
    try {
        const { notebookId } = req.params

        if (!notebookId || typeof notebookId !== "string") {
            return response.userError(res, "notebookId tidak valid")
        }

        const notebookObjectId = new mongoose.Types.ObjectId(notebookId)

        const existing = await TableOfContents.findOne({ notebookId: notebookObjectId }).lean()
        if (existing) {
            return response.requestSuccessWithData(
                res,
                "berhasil mendapatkan daftar bab",
                { toc: existing },
                200,
            )
        }

        const toc = await doGenerate(notebookId)
        return response.requestSuccessWithData(
            res,
            "berhasil mendapatkan daftar bab",
            { toc },
            200,
        )
    } catch (error) {
        if (error instanceof Error && error.message === "422") {
            return response.userError(
                res,
                "belum ada dokumen yang selesai diproses di notebook ini",
                422,
            )
        }
        tocLogger.error(
            { event: "toc.generation.failed", notebookId: req.params.notebookId, err: error },
            "Failed to generate table of contents",
        )
        return response.serverError(res, "Gagal menyusun daftar bab, silakan coba lagi.")
    }
}

export const regenerateToc = async (req: Request, res: Response) => {
    try {
        const { notebookId } = req.params

        if (!notebookId || typeof notebookId !== "string") {
            return response.userError(res, "notebookId tidak valid")
        }

        const notebookObjectId = new mongoose.Types.ObjectId(notebookId)

        await TableOfContents.deleteOne({ notebookId: notebookObjectId })

        const toc = await doGenerate(notebookId)

        return response.requestSuccessWithData(
            res,
            "berhasil membuat daftar bab",
            { toc },
            201,
        )
    } catch (error) {
        if (error instanceof Error && error.message === "422") {
            return response.userError(
                res,
                "belum ada dokumen yang selesai diproses di notebook ini",
                422,
            )
        }
        tocLogger.error(
            { event: "toc.generation.failed", notebookId: req.params.notebookId, err: error },
            "Failed to regenerate table of contents",
        )
        return response.serverError(res, "Gagal menyusun daftar bab, silakan coba lagi.")
    }
}
