import type { Request, Response } from "express"
import mongoose from "mongoose"
import { GoogleGenerativeAI } from "@google/generative-ai"
import response from "../utils/response.js"
import Message from "../models/message.model.js"
import Document from "../models/document.model.js"
import Chunk from "../models/chunk.model.js"
import { generateQueryEmbedding } from "../services/embedding.js"
import { askLLM } from "../services/LLM.js"
import type { RetrievedChunk, ChatHistoryEntry } from "../services/LLM.js"
import envVariable from "../utils/ENV.js"
import { createModuleLogger, extractSafeError } from "../config/logger.js"

const ragLogger = createModuleLogger("rag")
const summaryLogger = createModuleLogger("summary")
const SUMMARY_MODEL_NAME = "gemini-3.5-flash"

// ─── INISIALISASI MODEL LLM ──────────────────────────────────────────────────
// Inisialisasi Google Generative AI khusus untuk pembuatan ringkasan (summary)
const summaryGenAI = new GoogleGenerativeAI(envVariable.GEMINI_MODEL)
const summaryModel = summaryGenAI.getGenerativeModel({ model: "gemini-3.5-flash" })

// ─── KONFIGURASI HYPERPARAMETER CHAT & RAG ──────────────────────────────────
// Batas riwayat percakapan sebelumnya yang dikirim ke LLM (multi-turn context)
const HISTORY_LIMIT = 4
// Jumlah chunk paling relevan yang diambil dari hasil vector search
const TOP_K = 5
// Jumlah kandidat teratas yang dievaluasi dalam ANN (Approximate Nearest Neighbor) index
const NUM_CANDIDATES = 100
// Batas maksimal chunk yang diambil untuk membuat ringkasan bab
const MAX_SUMMARY_CHUNKS = 25

/**
 * Melakukan pencarian vektor (Vector Search) di MongoDB Atlas untuk menemukan chunk
 * dokumen yang paling relevan secara semantik dengan pertanyaan pengguna.
 *
 * @param queryVector  - Vektor embedding dari pertanyaan/pesan pengguna (array float)
 * @param documentIds  - Daftar ObjectId dokumen yang valid/selesai diproses di notebook
 * @returns Array chunk relevan (`RetrievedChunk[]`) lengkap dengan metadata judul dan nomor halaman
 */
const vectorSearch = async (
    queryVector: number[],
    documentIds: mongoose.Types.ObjectId[],
): Promise<RetrievedChunk[]> => {
    // Pipeline agregasi MongoDB Atlas Vector Search
    const results = await Chunk.aggregate([
        {
            $vectorSearch: {
                index: "chunks_vector_index", // Nama search index vektor di MongoDB Atlas
                path: "embedding",            // Field yang menyimpan array vektor embedding
                queryVector,                   // Vektor pencarian
                numCandidates: NUM_CANDIDATES, // Kandidat yang dievaluasi algoritma HNSW
                limit: TOP_K,                  // Mengambil TOP_K chunk dengan similarity tertinggi
                filter: { documentId: { $in: documentIds } }, // Filter hanya dokumen di notebook ini
            },
        },
        {
            $project: {
                _id: 0,
                documentId: 1,
                content: 1,
                pageStart: 1,
                pageEnd: 1,
                score: { $meta: "vectorSearchScore" }, // Skor relevansi similarity vektor
            },
        },
    ])

    // Ambil judul dokumen secara efisien melalui titleMap agar tidak query berulang per chunk
    const docIds = [...new Set(results.map((r: { documentId: mongoose.Types.ObjectId }) => r.documentId.toString()))]
    const docs = await Document.find({ _id: { $in: docIds } }).select("title")
    const titleMap = new Map(docs.map((d) => [d._id.toString(), d.title]))

    // Format hasil menjadi struktur RetrievedChunk yang siap dikonsumsi oleh service LLM
    return results.map((r: {
        documentId: mongoose.Types.ObjectId
        content: string
        pageStart: number
        pageEnd: number
        score: number
    }): RetrievedChunk => ({
        documentId: r.documentId,
        documentTitle: titleMap.get(r.documentId.toString()) ?? "Unknown",
        pageStart: r.pageStart,
        pageEnd: r.pageEnd,
        content: r.content,
        score: r.score,
    }))
}

/**
 * Controller: Mengirim pesan pengguna dan menjalankan alur RAG (Retrieval-Augmented Generation).
 *
 * Alur kerja:
 * 1. Validasi autentikasi dan parameter notebookId.
 * 2. Cek apakah ada minimal 1 dokumen yang berstatus "done".
 * 3. Simpan pesan user ke collection `messages`.
 * 4. Ambil 4 riwayat pesan terakhir untuk konteks percakapan berkelanjutan.
 * 5. Buat embedding dari teks pertanyaan user.
 * 6. Lakukan vector search ke MongoDB untuk mengambil 5 chunk paling relevan.
 * 7. Panggil Gemini LLM dengan pertanyaan, chunk sumber, dan riwayat chat.
 * 8. Simpan jawaban assistant beserta sitasi ke database dan kembalikan ke client.
 *
 * Route: POST /chats/:notebookId
 */
export const sendMessage = async (req: Request, res: Response) => {
    try {
        // 1. Verifikasi autentikasi user
        const userId = req.userId
        if (!userId) {
            return response.userError(res, "tidak terautentikasi", 401)
        }

        const { notebookId } = req.params
        if (!notebookId || typeof notebookId !== "string") {
            return response.userError(res, "notebookId tidak valid")
        }
        const { message } = req.body as { message: string }

        // 2. Pastikan ada dokumen di notebook ini yang sudah selesai di-chunk & di-embed
        const readyDocuments = await Document.find({
            notebookId,
            parseStatus: "done",
        }).select("_id")

        if (readyDocuments.length === 0) {
            return response.userError(
                res,
                "belum ada dokumen yang selesai diproses di notebook ini",
                422,
            )
        }

        const documentIds = readyDocuments.map((d) => d._id as mongoose.Types.ObjectId)

        // 3. Simpan pesan user ke database
        const userMessage = await Message.create({
            notebookId,
            role: "user",
            content: message,
            citations: [],
            sourceType: null,
        })

        // 4. Ambil riwayat percakapan sebelumnya (maksimal 4 pesan) untuk konteks percakapan multi-turn
        const recentMessages = await Message.find({
            notebookId,
            _id: { $ne: userMessage._id },
        })
            .sort({ createdAt: -1 })
            .limit(HISTORY_LIMIT)
            .select("role content")
            .lean()

        // Balik urutan agar kronologis (paling lama -> paling baru)
        const history: ChatHistoryEntry[] = recentMessages
            .reverse()
            .map((m) => ({ role: m.role, content: m.content }))

        // 5. Generate query embedding vektor dari pesan user
        const queryVector = await generateQueryEmbedding(message)

        // 6. Pencarian vektor semantik untuk mendapatkan chunk materi yang relevan
        const retrievalStartedAt = Date.now()
        ragLogger.info(
            {
                event: "rag.retrieval.started",
                notebookId,
                candidateDocumentsCount: documentIds.length,
                numCandidates: NUM_CANDIDATES,
                topK: TOP_K,
            },
            "RAG retrieval started",
        )

        let chunks: RetrievedChunk[]
        try {
            chunks = await vectorSearch(queryVector, documentIds)
        } catch (retrievalErr) {
            ragLogger.error(
                {
                    event: "rag.retrieval.failed",
                    notebookId,
                    durationMs: Date.now() - retrievalStartedAt,
                    err: retrievalErr,
                },
                "RAG retrieval failed",
            )
            throw retrievalErr
        }

        const sourceDocumentsCount = new Set(chunks.map((c) => c.documentId.toString())).size
        const retrievalDurationMs = Date.now() - retrievalStartedAt
        ragLogger.info(
            {
                event: "rag.retrieval.completed",
                notebookId,
                numCandidates: NUM_CANDIDATES,
                retrievedChunksCount: chunks.length,
                sourceDocumentsCount,
                durationMs: retrievalDurationMs,
            },
            "RAG retrieval completed",
        )

        const contextSizeChars =
            chunks.reduce((sum, c) => sum + c.content.length, 0) +
            history.reduce((sum, h) => sum + h.content.length, 0)

        ragLogger.info(
            {
                event: "rag.context.completed",
                notebookId,
                retrievedChunksCount: chunks.length,
                sourceDocumentsCount,
                historyCount: history.length,
                contextSizeChars,
            },
            "RAG context assembled",
        )

        // 7. Kirim pertanyaan, chunk referensi, dan riwayat percakapan ke model LLM
        const llmResult = await askLLM(message, chunks, history)

        // 8. Simpan jawaban assistant beserta sitasi dokumen ke database
        const assistantMessage = await Message.create({
            notebookId,
            role: "assistant",
            content: llmResult.content,
            citations: llmResult.citations,
            sourceType: llmResult.sourceType,
        })

        return response.requestSuccessWithData(
            res,
            "berhasil kirim pesan",
            { userMessage, assistantMessage },
            200,
        )
    } catch (error) {
        ragLogger.error(
            {
                event: "rag.chat.failed",
                notebookId: req.params.notebookId,
                err: error,
            },
            "Failed to process RAG chat message",
        )
        return response.serverError(res, "Gagal mendapatkan jawaban, silakan coba lagi.")
    }
}

/**
 * Controller: Mengambil seluruh riwayat percakapan di dalam suatu notebook.
 *
 * Pesan diurutkan secara ascending berdasarkan waktu pembuatan (`createdAt: 1`)
 * agar percakapan dapat dirender dari atas ke bawah pada antarmuka chat.
 *
 * Route: GET /chats/:notebookId
 */
export const getMessages = async (req: Request, res: Response) => {
    try {
        const { notebookId } = req.params

        if (!notebookId || typeof notebookId !== "string") {
            return response.userError(res, "notebookId tidak valid")
        }

        // Ambil semua pesan dalam notebook secara kronologis
        const messages = await Message.find({ notebookId })
            .sort({ createdAt: 1 })
            .lean()
        ragLogger.debug(
            {
                event: "rag.messages.listed",
                notebookId,
                messagesCount: messages.length,
            },
            "Fetched chat message history",
        )

        return response.requestSuccessWithData(
            res,
            "berhasil dapet riwayat pesan",
            { messages },
            200,
        )
    } catch (error) {
        ragLogger.error(
            {
                event: "rag.messages.list_failed",
                notebookId: req.params.notebookId,
                err: error,
            },
            "Failed to fetch chat message history",
        )
        return response.serverError(res, "Gagal memuat riwayat obrolan, silahkan muat ulang halaman")
    }
}

/**
 * Helper: Menyusun blok teks sumber materi berformat `SOURCE [n]` untuk prompt ringkasan.
 *
 * Format terstruktur ini memudahkan Gemini untuk mereferensikan sitasi `[1]`, `[2]`, dst.
 * secara akurat sesuai chunk halaman asal.
 */
const buildSummarySourceBlock = (
    chunks: { pageStart: number; pageEnd: number; content: string }[],
    documentTitle: string,
): string =>
    chunks
        .map((c, i) => [
            `SOURCE [${i + 1}]`,
            `Document: ${documentTitle}`,
            `Pages: ${c.pageStart}–${c.pageEnd}`,
            `Content: "${c.content}"`,
        ].join("\n"))
        .join("\n\n")

/**
 * Helper: Membangun prompt lengkap untuk meminta LLM membuat ringkasan bab.
 *
 * Aturan prompt:
 * - 5 sampai 8 poin utama ide penting dari bab.
 * - Wajib menyertakan sitasi interaktif `[n]` di setiap poin berdasarkan nomor `SOURCE`.
 * - Grounded generation: tidak boleh menyitir atau berhalusinasi di luar teks sumber yang diberikan.
 */
const buildSummaryPrompt = (
    chapterTitle: string,
    pageStart: number,
    pageEnd: number,
    documentTitle: string,
    chunks: { pageStart: number; pageEnd: number; content: string }[],
): string => {
    const sourceBlock = buildSummarySourceBlock(chunks, documentTitle)
    return [
        sourceBlock,
        "",
        "---",
        `Buat ringkasan Bab "${chapterTitle}" (halaman ${pageStart}–${pageEnd}) dari dokumen "${documentTitle}" dalam 5 sampai 8 poin utama.`,
        "",
        "Aturan:",
        "- Setiap poin harus mewakili ide penting dari bab ini",
        "- Sertakan citation dengan format [1], [2], dst. di setiap poin",
        "- Jangan membuat citation di luar SOURCE yang diberikan",
        "- Gunakan Bahasa Indonesia",
    ].join("\n")
}

/**
 * Controller: Membuat ringkasan bab dari dokumen yang dipilih berdasarkan rentang halaman.
 *
 * Alur kerja:
 * 1. Validasi input: documentId, chapterTitle, pageStart, pageEnd.
 * 2. Cek keberadaan dokumen di notebook bersangkutan.
 * 3. Ambil chunk teks dokumen yang berada dalam rentang halaman bab (maksimal 25 chunk).
 * 4. Simpan pesan permintaan ringkasan dari user ke riwayat chat.
 * 5. Panggil Gemini (gemini-3.5-flash) secara stateless (tanpa riwayat obrolan).
 * 6. Parse nomor sitasi `[n]` yang digunakan LLM dan re-number agar berurutan mulai dari [1].
 * 7. Simpan respons ringkasan assistant beserta array sitasi lengkap ke database.
 *
 * Route: POST /chats/:notebookId/summary
 */
export const createChapterSummary = async (req: Request, res: Response) => {
    const startedAt = Date.now()
    try {
        // 1. Verifikasi autentikasi user
        const userId = req.userId
        if (!userId) {
            return response.userError(res, "tidak terautentikasi", 401)
        }

        const { notebookId } = req.params
        if (!notebookId || typeof notebookId !== "string") {
            return response.userError(res, "notebookId tidak valid")
        }

        const { documentId, chapterTitle, pageStart, pageEnd } = req.body as {
            documentId: string
            chapterTitle: string
            pageStart: number
            pageEnd: number
        }

        // 2. Verifikasi dokumen terdaftar di notebook dan status pemrosesannya selesai
        const doc = await Document.findOne({
            _id: documentId,
            notebookId,
            parseStatus: "done",
        }).select("_id title")

        if (!doc) {
            return response.notFoundError(res, "dokumen tidak ditemukan atau belum selesai diproses")
        }

        // 3. Ambil chunks dokumen yang berada di dalam rentang halaman bab
        const rawChunks = await Chunk.find({
            documentId: new mongoose.Types.ObjectId(documentId),
            pageStart: { $gte: pageStart },
            pageEnd: { $lte: pageEnd },
        })
            .select("pageStart pageEnd content")
            .sort({ pageStart: 1 })
            .limit(MAX_SUMMARY_CHUNKS)
            .lean()

        if (rawChunks.length === 0) {
            return response.userError(
                res,
                "Tidak ada konten pada rentang halaman ini",
                422,
            )
        }

        // 4. Simpan pesan permintaan ringkasan sebagai pesan dari user
        const userContent = `Buatkan ringkasan Bab ${chapterTitle} (hlm. ${pageStart}–${pageEnd}) dari ${doc.title}`
        const userMessage = await Message.create({
            notebookId,
            role: "user",
            content: userContent,
            citations: [],
            sourceType: null,
        })

        // 5. Bangun prompt ringkasan dengan blok sumber terstruktur
        const summaryPrompt = buildSummaryPrompt(
            chapterTitle,
            pageStart,
            pageEnd,
            doc.title,
            rawChunks,
        )

        // 6. Generate ringkasan dengan Gemini (stateless tanpa history percakapan)
        const llmStartedAt = Date.now()
        summaryLogger.info(
            {
                event: "ai.generation.started",
                provider: "google-gemini",
                model: SUMMARY_MODEL_NAME,
                operation: "chapter_summary",
                notebookId,
                documentId,
            },
            "LLM summary generation started",
        )

        let responseText: string
        try {
            const result = await summaryModel.generateContent(summaryPrompt)
            responseText = result.response.text()
            const usageMetadata = result.response.usageMetadata
            summaryLogger.info(
                {
                    event: "ai.generation.completed",
                    provider: "google-gemini",
                    model: SUMMARY_MODEL_NAME,
                    operation: "chapter_summary",
                    durationMs: Date.now() - llmStartedAt,
                    ...(usageMetadata ? { tokenUsage: usageMetadata } : {}),
                },
                "LLM summary generation completed",
            )
        } catch (llmErr) {
            const safeErr = extractSafeError(llmErr)
            summaryLogger.error(
                {
                    event: "ai.generation.failed",
                    provider: "google-gemini",
                    model: SUMMARY_MODEL_NAME,
                    operation: "chapter_summary",
                    durationMs: Date.now() - llmStartedAt,
                    errorCategory: safeErr.errorCategory,
                    ...(safeErr.providerStatus !== undefined ? { providerStatus: safeErr.providerStatus } : {}),
                    err: llmErr,
                },
                "LLM summary generation failed",
            )
            throw llmErr
        }

        // 7. Ekstraksi dan penataan ulang nomor sitasi (Re-numbering citations)
        // Contoh: Jika model mengutip [3] dan [7], akan dinormalkan menjadi [1] dan [2]
        const citationRegex = /\[(\d+)\]/g
        const foundIndices = new Set<number>()
        let m: RegExpExecArray | null
        while ((m = citationRegex.exec(responseText)) !== null) {
            const raw = m[1]
            if (!raw) continue
            const idx = parseInt(raw, 10)
            if (idx >= 1 && idx <= rawChunks.length) foundIndices.add(idx)
        }

        // Petakan indeks lama ke metadata sitasi baru yang berurutan
        const rawCitations = Array.from(foundIndices)
            .sort((a, b) => a - b)
            .map((oldIdx, i) => {
                const chunk = rawChunks[oldIdx - 1]!
                return {
                    oldIdx,
                    citation: {
                        citationIndex: i + 1,
                        documentId: doc._id as mongoose.Types.ObjectId,
                        documentTitle: doc.title,
                        pageStart: chunk.pageStart,
                        pageEnd: chunk.pageEnd,
                        chunkContent: chunk.content,
                    },
                }
            })

        // Ganti nomor sitasi pada teks jawaban menggunakan placeholder sementara untuk menghindari tabrakan angka
        let finalContent = responseText
        for (const { oldIdx, citation } of rawCitations) {
            finalContent = finalContent.replaceAll(`[${oldIdx}]`, `[__${citation.citationIndex}__]`)
        }
        finalContent = finalContent.replace(/\[__(\d+)__\]/g, "[$1]")

        const citations = rawCitations.map((r) => r.citation)

        // 8. Simpan pesan jawaban assistant beserta sitasi yang sudah ditata ke database
        const assistantMessage = await Message.create({
            notebookId,
            role: "assistant",
            content: finalContent,
            citations,
            sourceType: "document",
        })
        summaryLogger.info(
            {
                event: "summary.generation.completed",
                notebookId,
                documentId,
                chunksCount: rawChunks.length,
                citationsCount: citations.length,
                durationMs: Date.now() - startedAt,
            },
            "Chapter summary generated",
        )

        return response.requestSuccessWithData(
            res,
            "berhasil membuat ringkasan bab",
            { userMessage, assistantMessage },
            200,
        )
    } catch (error) {
        summaryLogger.error(
            {
                event: "summary.generation.failed",
                notebookId: req.params.notebookId,
                durationMs: Date.now() - startedAt,
                err: error,
            },
            "Chapter summary generation failed",
        )
        return response.serverError(res, "Gagal membuat ringkasan, silakan coba lagi.")
    }
}
