import fs from "fs";
import path from "path";
import type { Request, Response } from "express";
import response from "../utils/response.js";
import Notebook from "../models/notebook.model.js";
import Document from "../models/document.model.js";
import Chunk from "../models/chunk.model.js";
import Note from "../models/note.model.js";
import Message from "../models/message.model.js";
import TableOfContents from "../models/toc.model.js";
import envVariable from "../utils/ENV.js";
import { createModuleLogger } from "../config/logger.js";

const notebookLogger = createModuleLogger("notebook");

export const createNotebook = async (req: Request, res: Response) => {
  try {
    const { title, description } = req.body;
    const userId = req.userId;
    if (!userId) {
      return response.userError(res, "tidak terautentikasi");
    }

    const notebook = await Notebook.create({ description, title, userId });
    notebookLogger.info(
      {
        event: "notebook.created",
        notebookId: notebook._id.toString(),
        userId,
      },
      "Notebook created",
    );
    return response.requestSuccessWithData(
      res,
      "berhasil buat notebook",
      { notebook },
      201,
    );
  } catch (error) {
    notebookLogger.error(
      { event: "notebook.create.failed", userId: req.userId, err: error },
      "Failed to create notebook",
    );
    return response.serverError(res, "gagal buat notebook");
  }
};

export const getAllNotebookUser = async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const sortBy = req.query.sortBy;

    const sort: Record<string, 1 | -1> = {
      isPinned: -1,
    };

    if (sortBy === "title") {
      sort.title = 1;
    } else {
      sort.createdAt = -1;
    }

    if (!userId) {
      return response.userError(res, "tidak terautentikasi");
    }
    const limit = 10;

    const page = Number(req.query.page ?? 1);

    if (!Number.isInteger(page) || page < 1) {
      return response.userError(res, "halaman harus bilangan bulat minimal 1", 400);
    }

    const skip = (page - 1) * limit;
    const { title } = req.query;

    const filter: Record<string, any> = {
      userId,
    };
    if (typeof title === "string" && title.trim()) {
      filter.title = {
        $regex: title.trim(),
        $options: "i",
      };
    }
    const count = await Notebook.countDocuments(filter);

    const notebooks = await Notebook.find(filter)
      .sort(sort)
      .populate({
        path: "jumlah_sumber",
        select: "-fileUrl",
      })
      .lean({ virtuals: true })
      .skip(skip)
      .limit(limit);

    const totalPages = Math.ceil(count / limit);
    notebookLogger.debug(
      {
        event: "notebook.listed",
        userId,
        page,
        totalNotebook: count,
      },
      "Listed user notebooks",
    );
    return response.requestSuccessWithData(
      res,
      "berhasil mendapatkan semua notebook user",
      {
        notebooks,
        pagination: {
          page,
          limit,
          totalNotebook: count,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
      200,
    );
  } catch (error) {
    notebookLogger.error(
      { event: "notebook.list.failed", userId: req.userId, err: error },
      "Failed to list notebooks",
    );

    return response.serverError(res, "gagal mendapatkan semua notebook user");
  }
};

export const deleteNotebook = async (req: Request, res: Response) => {
  try {
    const { notebookId } = req.params;

    const notebook = await Notebook.findById(notebookId);

    if (!notebook) {
      return response.notFoundError(res, "notebook tidak ditemukan");
    }

    const documents = await Document.find({ notebookId: notebook._id });

    // Hapus file fisik dari disk untuk setiap dokumen
    const base = envVariable.UPLOAD_BASE_URL.replace(/\/$/, "");
    for (const document of documents) {
      if (document.fileUrl) {
        const relativePath = document.fileUrl.replace(base, "");
        const filePath = path.join(envVariable.UPLOADS_DIR, relativePath);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    }

    const documentIds = documents.map((document) => document._id);

    if (documentIds.length > 0) {
      await Chunk.deleteMany({
        documentId: { $in: documentIds },
      });

      await Document.deleteMany({
        _id: { $in: documentIds },
      });
    }

    await Note.deleteMany({ notebookId: notebook._id });
    await Message.deleteMany({ notebookId: notebook._id });
    await TableOfContents.deleteOne({ notebookId: notebook._id });
    await notebook.deleteOne();
    notebookLogger.info(
      {
        event: "notebook.deleted",
        notebookId: notebook._id.toString(),
        userId: req.userId,
        deletedDocumentsCount: documentIds.length,
      },
      "Notebook deleted",
    );
    return response.requestSuccess(res, "berhasil hapus notebook");
  } catch (error) {
    notebookLogger.error(
      { event: "notebook.delete.failed", notebookId: req.params.notebookId, userId: req.userId, err: error },
      "Failed to delete notebook",
    );

    return response.serverError(res, "gagal hapus notebook");
  }
};

export const getNotebookById = async (req: Request, res: Response) => {
  try {
    const { notebookId } = req.params;
    if (!notebookId || typeof notebookId !== "string") {
      return response.userError(res, "notebookId tidak valid");
    }
    const notebook = await Notebook.findById(notebookId);
    if (!notebook) {
      return response.notFoundError(res, "notebook tidak ditemukan");
    }
    const notes = await Note.find({ notebookId });
    const documents = await Document.find({ notebookId });
    notebookLogger.debug(
      {
        event: "notebook.fetched",
        notebookId,
        userId: req.userId,
        notesCount: notes.length,
        documentsCount: documents.length,
      },
      "Fetched notebook detail",
    );

    response.requestSuccessWithData(
      res,
      "berhasil dapet notebook",
      { notebook, notes, documents },
      200,
    );
  } catch (error) {
    notebookLogger.error(
      { event: "notebook.fetch.failed", notebookId: req.params.notebookId, userId: req.userId, err: error },
      "Failed to fetch notebook detail",
    );
    return response.serverError(res, "gagal dapet notebook by id");
  }
};

export const pinNotebook = async (req: Request, res: Response) => {
  try {
    const { notebookId } = req.params;
    if (!notebookId || typeof notebookId !== "string") {
      return response.userError(res, "notebookId tidak valid");
    }
    const { pinned } = req.body;
    const notebook = await Notebook.findByIdAndUpdate(
      notebookId,
      { isPinned: pinned },
      { returnDocument: "after" },
    );
    if (!notebook) {
      return response.notFoundError(res, "notebook tidak ditemukan");
    }
    notebookLogger.info(
      {
        event: "notebook.updated",
        notebookId,
        userId: req.userId,
        isPinned: Boolean(pinned),
      },
      "Notebook pin status updated",
    );
    response.requestSuccessWithData(
      res,
      "berhasil pin notebook",
      { notebook },
      200,
    );
  } catch (error) {
    notebookLogger.error(
      { event: "notebook.pin.failed", notebookId: req.params.notebookId, userId: req.userId, err: error },
      "Failed to pin notebook",
    );
    return response.serverError(res, "gagal pin notebook");
  }
};

export const updateNotebook = async (req: Request, res: Response) => {
  try {
    const { notebookId } = req.params;
    if (!notebookId || typeof notebookId !== "string") {
      return response.userError(res, "notebookId tidak valid");
    }
    const { title, description } = req.body;
    let updateDataNotebook = {};
    if (title) {
      updateDataNotebook = { title };
    }
    if (description) {
      updateDataNotebook = { ...updateDataNotebook, description };
    }

    const notebook = await Notebook.findByIdAndUpdate(
      notebookId,
      { ...updateDataNotebook },
      { returnDocument: "after" },
    );
    if (!notebook) {
      return response.notFoundError(res, "notebook tidak ditemukan");
    }
    notebookLogger.info(
      {
        event: "notebook.updated",
        notebookId,
        userId: req.userId,
      },
      "Notebook updated",
    );
    response.requestSuccessWithData(
      res,
      "berhasil update notebook",
      { notebook },
      200,
    );
  } catch (error) {
    notebookLogger.error(
      { event: "notebook.update.failed", notebookId: req.params.notebookId, userId: req.userId, err: error },
      "Failed to update notebook",
    );
    return response.serverError(res, "gagal update notebook");
  }
};
