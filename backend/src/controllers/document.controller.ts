import fs from "fs"
import path from "path"
import type { Request, Response } from "express"
import mongoose from "mongoose"
import Document from "../models/document.model.js"
import Notebook from "../models/notebook.model.js"
import Chunk from "../models/chunk.model.js"
import TableOfContents from "../models/toc.model.js"
import { chunkPDF, chunkPPTX, chunkTXT, chunkDOCX, NoTextError, ParseError, cleanPdfText } from "../services/chunking.js"

const MIN_CONTENT_CHARS = 50
import response from "../utils/response.js"
import envVariable from "../utils/ENV.js"
import Message from "../models/message.model.js"
import { createModuleLogger } from "../config/logger.js"

const docLogger = createModuleLogger("document")

type FileType = "pdf" | "pptx" | "txt" | "docx"

const MIME_TO_FILETYPE: Record<string, FileType> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "text/plain": "txt",
}

const MIME_TO_EXT: Record<string, string> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "text/plain": "txt",
}

const saveFileToDisk = (
    buffer: Buffer,
    baseName: string,
    mimetype: string,
    userId: string,
    notebookId: string,
): string => {
    const ext = MIME_TO_EXT[mimetype] ?? "bin"
    const filename = `${baseName}.${ext}`
    const dir = path.join(envVariable.UPLOADS_DIR, "documents", userId, notebookId)

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }

    const filePath = path.join(dir, filename)
    fs.writeFileSync(filePath, buffer)

    const base = envVariable.UPLOAD_BASE_URL.replace(/\/$/, "")
    return `${base}/documents/${userId}/${notebookId}/${filename}`
}

export const generateUniqueFileName = async (
    notebookId: string,
    originalName: string
): Promise<string> => {
    const extension = originalName.match(/\.[^.]+$/)?.[0] ?? ""
    const baseName = originalName.replace(/\.[^.]+$/, "")

    let newName = originalName
    let counter = 1

    while (
        await Document.exists({
            notebookId,
            title: newName.replace(/\.[^.]+$/, ""),  
        })
    ) {
        newName = `${baseName} (${counter})${extension}`
        counter++
    }

    return newName
}

// ── upload document ──────────────────────────────────────────────────────────

export const uploadDocument = async (req: Request, res: Response) => {
    try {
        const userId = req.userId
        if (!userId) {
            return response.userError(res, "tidak terautentikasi")
        }

        const { notebookId } = req.params

        if (!notebookId || typeof notebookId !== "string") {
            return response.userError(res, "notebookId tidak valid")
        }

        const notebook = await Notebook.findOne({ _id: notebookId, userId })
        if (!notebook) {
            return response.notFoundError(res, "notebook tidak ditemukan atau bukan milik user")
        }

        if (!req.file) {
            return response.userError(res, "file tidak ditemukan, kirim file dengan field name 'file'")
        }

        const { originalname, mimetype, buffer, size } = req.file
        const fileType = MIME_TO_FILETYPE[mimetype]

        if (!fileType) {
            return response.userError(res, "Format tidak didukung, hanya PDF, PPTX, DOCX, dan TXT")
        }

        docLogger.info(
            {
                event: "document.upload.started",
                notebookId,
                userId,
                fileType,
                fileSize: size,
                status: "started",
            },
            "Document upload started",
        )

        const originalBaseName = originalname
        .replace(/\.[^.]+$/, "")
        .replace(/\s+/g, "_")
        
        const extension = originalname.match(/\.[^.]+$/)?.[0] ?? ""

        const uniqueFileName = await generateUniqueFileName(
            notebookId,
            `${originalBaseName}${extension}`
        )

        const baseName = uniqueFileName.replace(/\.[^.]+$/, "")

        const fileUrl = saveFileToDisk(buffer, baseName, mimetype, userId, notebookId)

        const notebookObjectId = new mongoose.Types.ObjectId(notebookId)

        const doc = await Document.create({
            notebookId: notebookObjectId,
            title: baseName,
            fileType,
            fileUrl,
            fileSize: size,
            totalPages: 0,
            parseStatus: "pending",
        })

        const requestId = req.requestId
        const documentId = doc._id.toString()

        docLogger.info(
            {
                event: "document.upload.completed",
                documentId,
                notebookId,
                userId,
                fileType,
                fileSize: size,
                status: "pending",
            },
            "Document uploaded and queued for processing",
        )

        // proses chunking setelah response dikirim ke FE supaya tidak block user
        setImmediate(async () => {
            const bgLogger = createModuleLogger("document", {
                ...(requestId ? { requestId } : {}),
                documentId,
                notebookId,
                fileType,
                fileSize: size,
            })
            const startedAt = Date.now()
            try {
                const { chunks, totalPages } = fileType === "pdf"
                    ? await chunkPDF(buffer, doc._id)
                    : fileType === "pptx"
                        ? await chunkPPTX(buffer, doc._id)
                        : fileType === "docx"
                            ? await chunkDOCX(buffer, doc._id)
                            : await chunkTXT(buffer, doc._id)

                bgLogger.info(
                    {
                        event: "document.parse.completed",
                        totalPages,
                        totalChunks: chunks.length,
                        durationMs: Date.now() - startedAt,
                        status: "parsed",
                    },
                    "Document parsing completed",
                )

                // tolak dokumen yang kontennya terlalu sedikit — hapus dari DB dan disk
                const totalChars = chunks.reduce((sum, c) => sum + c.content.length, 0)
                if (totalChars < MIN_CONTENT_CHARS) {
                    const base = envVariable.UPLOAD_BASE_URL.replace(/\/$/, "")
                    const relativePath = doc.fileUrl.replace(base, "")
                    const filePath = path.join(envVariable.UPLOADS_DIR, relativePath)
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
                    await doc.deleteOne()
                    bgLogger.warn(
                        {
                            event: "document.chunking.failed",
                            reason: "insufficient_content",
                            totalPages,
                            totalChunks: chunks.length,
                            durationMs: Date.now() - startedAt,
                            status: "rejected",
                        },
                        "Document rejected due to insufficient content",
                    )
                    return
                }

                if (chunks.length > 0) {
                    await Chunk.insertMany(chunks)
                }

                await Document.findByIdAndUpdate(doc._id, {
                    parseStatus: "done",
                    totalPages,
                    parseError: "",
                })

                // hapus ToC lama supaya GET /toc akan generate ulang dengan dokumen terbaru
                await TableOfContents.deleteOne({ notebookId: doc.notebookId })

                bgLogger.info(
                    {
                        event: "document.chunking.completed",
                        totalPages,
                        totalChunks: chunks.length,
                        durationMs: Date.now() - startedAt,
                        status: "done",
                    },
                    "Document chunking completed",
                )
            } catch (err) {
                const errorMessage = err instanceof Error
                    ? err.message
                    : "Gagal memproses dokumen, silakan coba lagi."
                const durationMs = Date.now() - startedAt
                const isParseFailure = err instanceof NoTextError || err instanceof ParseError

                bgLogger.error(
                    {
                        event: isParseFailure ? "document.parse.failed" : "document.chunking.failed",
                        durationMs,
                        status: "error",
                        err,
                    },
                    "Document processing failed",
                )

                // hapus dari DB dan disk supaya tidak muncul di list
                try {
                    const base = envVariable.UPLOAD_BASE_URL.replace(/\/$/, "")
                    const relativePath = doc.fileUrl.replace(base, "")
                    const filePath = path.join(envVariable.UPLOADS_DIR, relativePath)
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
                    await doc.deleteOne()
                } catch (cleanupErr) {
                    // cleanup gagal — tandai error supaya tidak stuck di pending
                    bgLogger.error(
                        {
                            event: "document.cleanup.failed",
                            status: "error",
                            err: cleanupErr,
                        },
                        "Failed to clean up failed document",
                    )
                    await Document.findByIdAndUpdate(doc._id, {
                        parseStatus: "error",
                        parseError: errorMessage,
                    })
                }
            }
        })

        return response.requestSuccessWithData(res, "berhasil upload dokumen", { document: doc }, 201)
    } catch (error) {
        docLogger.error(
            {
                event: "document.upload.failed",
                notebookId: req.params.notebookId,
                userId: req.userId,
                status: "failed",
                err: error,
            },
            "Document upload failed",
        )
        return response.serverError(res, "gagal upload dokumen")
    }
}


export const getDocumentsByNotebook = async (req: Request, res: Response) => {
    try {
        const userId = req.userId
        if (!userId) {
            return response.userError(res, "tidak terautentikasi")
        }

        const { notebookId } = req.params

        if (!notebookId || typeof notebookId !== "string") {
            return response.userError(res, "notebookId tidak valid")
        }

        const notebook = await Notebook.findOne({ _id: notebookId, userId })
        if (!notebook) {
            return response.notFoundError(res, "notebook tidak ditemukan atau bukan milik user")
        }

        const notebookObjectId = new mongoose.Types.ObjectId(notebookId)
        const documents = await Document.find({
                        notebookId: notebookObjectId,
                        parseStatus: { $in: ["done", "pending"] }
                    }).sort({ createdAt: -1 })

        return response.requestSuccessWithData(res, "berhasil get dokumen", { documents }, 200)
    } catch (error) {
        docLogger.error(
            { event: "document.list.failed", notebookId: req.params.notebookId, userId: req.userId, err: error },
            "Failed to list documents",
        )
        return response.serverError(res, "gagal get dokumen")
    }
}

// delete document — kepemilikan dicek di isDocumentOwner
export const deleteDocument = async (req: Request, res: Response) => {
    try {
        const { documentId } = req.params

        const doc = await Document.findById(documentId)
        if (!doc) {
            return response.notFoundError(res, "dokumen tidak ditemukan")
        }

        const base = envVariable.UPLOAD_BASE_URL.replace(/\/$/, "")
        const relativePath = doc.fileUrl.replace(base, "")  
        const filePath = path.join(envVariable.UPLOADS_DIR, relativePath)

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
        }

        try {
            const parentDir = path.dirname(filePath)
            if (fs.readdirSync(parentDir).length === 0) {
                fs.rmdirSync(parentDir)
            }
        } catch {
        }

        await Chunk.deleteMany({ documentId: doc._id })
        await doc.deleteOne()

        docLogger.info(
            {
                event: "document.deleted",
                documentId: doc._id.toString(),
                notebookId: doc.notebookId.toString(),
                fileType: doc.fileType,
                fileSize: doc.fileSize,
                userId: req.userId,
                status: "deleted",
            },
            "Document deleted",
        )

        return response.requestSuccess(res, "berhasil hapus dokumen")
    } catch (error) {
        docLogger.error(
            { event: "document.delete.failed", documentId: req.params.documentId, userId: req.userId, err: error },
            "Failed to delete document",
        )
        return response.serverError(res, "gagal hapus dokumen")
    }
}


// update nama document — kepemilikan dicek di isDocumentOwner
export const updateDocument = async (req: Request, res: Response) => {
    try {
        const { name } = req.body
        const { documentId } = req.params

        const document = await Document.findByIdAndUpdate(
            documentId,
            { $set: { title: name } },
            { returnDocument: "after" },
        )

        if (!document) {
            return response.notFoundError(res, "document ga ketemu")
        }

        await Message.updateMany(
            {
                "citations.documentId": document._id,
            },
            {
                $set: {
                    "citations.$[citation].documentTitle": name,
                },
            },
            {
                arrayFilters: [
                    { "citation.documentId": document._id },
                ],
            },
        )

        docLogger.info(
            {
                event: "document.updated",
                documentId: document._id.toString(),
                notebookId: document.notebookId.toString(),
                userId: req.userId,
            },
            "Document updated",
        )

        return response.requestSuccessWithData(
            res,
            "berhasil update document",
            { document },
            200,
        )
    } catch (error) {
        docLogger.error(
            { event: "document.update.failed", documentId: req.params.documentId, userId: req.userId, err: error },
            "Failed to update document",
        )
        return response.serverError(res, "gagal update dokumen")
    }
}


export const getDocumentPage = async (req: Request, res: Response) => {
    try {
        const { documentId, page: pageParam } = req.params
        
        if (typeof pageParam !== "string") {
            return response.userError(res, "nomor halaman tidak valid", 400)
        }
        const page = parseInt(pageParam ?? "", 10)


        if (isNaN(page) || page < 1) {
            return response.userError(res, "nomor halaman tidak valid", 400)
        }

        const doc = await Document.findById(documentId).lean()
        if (!doc) {
            return response.notFoundError(res, "dokumen tidak ditemukan")
        }

        if (page > doc.totalPages) {
            return response.userError(res, "nomor halaman tidak valid", 400)
        }
        const isPageBased = doc.fileType === "pdf" || doc.fileType === "pptx"

        const chunks = isPageBased
            ? await Chunk.find({
                  documentId: doc._id,
                  pageStart: { $lte: page },
                  pageEnd: { $gte: page },
              })
                  .select("content")
                  .sort({ chunkIndex: 1 })
                  .lean()
            : await Chunk.find({
                  documentId: doc._id,
                  chunkIndex: page - 1,
              })
                  .select("content")
                  .lean()

        if (chunks.length === 0) {
            return response.notFoundError(res, "konten halaman tidak ditemukan")
        }

        const rawContent = chunks.map((c) => c.content).join("\n\n")
        const content = cleanPdfText(rawContent)

        return response.requestSuccessWithData(res, "berhasil mendapatkan isi halaman", {
            documentId: doc._id,
            documentTitle: doc.title,
            fileType: doc.fileType,
            page,
            totalPages: doc.totalPages,
            content,
        }, 200)
    } catch (error) {
        docLogger.error(
            { event: "document.page.fetch_failed", documentId: req.params.documentId, err: error },
            "Failed to get document page",
        )
        return response.serverError(res, "gagal mendapatkan isi halaman")
    }
}

export const getDocumentStatus = async (req: Request, res: Response) => {
    try {
        const userId = req.userId
        if (!userId) {
            return response.userError(res, "tidak terautentikasi")
        }

        const { documentId } = req.params

        const doc = await Document.findById(documentId)
            .select("parseStatus parseError totalPages notebookId")
            .populate<{ notebookId: { userId: { toString(): string } } }>("notebookId", "userId")

        if (!doc) {
            return response.notFoundError(res, "dokumen tidak ditemukan")
        }

        if (doc.notebookId.userId.toString() !== userId) {
            return response.notAuthorizedError(res, "tidak punya akses ke dokumen ini")
        }

        return response.requestSuccessWithData(res, "berhasil get status dokumen", {
            parseStatus: doc.parseStatus,
            parseError:  doc.parseError,
            totalPages:  doc.totalPages,
        }, 200)
    } catch (error) {
        docLogger.error(
            { event: "document.status.fetch_failed", documentId: req.params.documentId, err: error },
            "Failed to get document status",
        )
        return response.serverError(res, "gagal get status dokumen")
    }
}
