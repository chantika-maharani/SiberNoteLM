import type { Request, Response } from "express";
import response from "../utils/response.js";
import Note from "../models/note.model.js";
import { createModuleLogger } from "../config/logger.js";

const noteLogger = createModuleLogger("note");

export const createNote = async (req:Request, res:Response) => {
    try {
        const { notebookId } = req.params
        const { title, content } = req.body
        if (!notebookId || typeof notebookId !== "string") {
            return response.userError(res, "notebookId tidak valid")
        }
        const note = await Note.create({ content, title, notebookId })
        noteLogger.info({ event: "note.created", notebookId, noteId: note._id.toString() }, "Note created")
        response.requestSuccessWithData(res,"berhasil buat note",{note},201)
    } catch (error) {
        noteLogger.error({ event: "note.create.failed", notebookId: req.params.notebookId, err: error }, "Failed to create note")
        response.serverError(res,"gagal create note")
    }
}

export const getAllNoteByNotebookId = async (req:Request, res:Response) => {
    try {
        const { notebookId } = req.params
        if (!notebookId || typeof notebookId !== "string") {
            return response.userError(res, "notebookId tidak valid")
        }
        const notes = await Note.find({ notebookId })
        noteLogger.debug({ event: "note.listed", notebookId, count: notes.length }, "Listed notebook notes")
        response.requestSuccessWithData(res,"berhasil dapet semua note",{notes},200)
    } catch (error) {
        noteLogger.error({ event: "note.list.failed", notebookId: req.params.notebookId, err: error }, "Failed to list notes")
        response.serverError(res,"gagal dapet semua note")
    }
}

export const deleteNote = async (req: Request, res: Response) => {
    try {
        const { noteId } = req.params
        if (!noteId || typeof noteId !== "string") {
            return response.userError(res, "noteId tidak valid")
        }
        const note = await Note.findById(noteId)
        if (!note) {
            return response.notFoundError(res,"note tidak ditemukan atau sudah dihapus")
        }
        await Note.findByIdAndDelete(noteId)
        noteLogger.info({ event: "note.deleted", notebookId: req.params.notebookId, noteId }, "Note deleted")
        response.requestSuccess(res,"berhasil hapus note")
    } catch (error) {
        noteLogger.error({ event: "note.delete.failed", notebookId: req.params.notebookId, noteId: req.params.noteId, err: error }, "Failed to delete note")
        response.serverError(res,"gagal hapus note")
    }
}

export const getNoteById = async(req: Request, res: Response)=>{
    try {
        const { noteId } = req.params
        if (!noteId || typeof noteId !== "string") {
            return response.userError(res, "noteId tidak valid")
        }
        const note = await Note.findById(noteId)
        if (!note) {
            return response.notFoundError(res, "note tidak ditemukan")
        }
        noteLogger.debug({ event: "note.fetched", notebookId: req.params.notebookId, noteId }, "Fetched note")
        response.requestSuccessWithData(res, "berhasil dapet note", { note }, 200)
    } catch (error) {
        noteLogger.error({ event: "note.fetch.failed", notebookId: req.params.notebookId, noteId: req.params.noteId, err: error }, "Failed to fetch note")
        response.serverError(res,"gagal dapet note by id")
    }
}

export const updateNote = async (req: Request, res: Response) => {
    try {
        const { noteId } = req.params
        if (!noteId || typeof noteId !== "string") {
            return response.userError(res, "noteId tidak valid")
        }
        const { title, content } = req.body
        let updateDataNote = {}
        if (title) {
            updateDataNote = { title }
        }
        if (content) {
            updateDataNote = { ...updateDataNote, content }
        }
        
        const note = await Note.findByIdAndUpdate(noteId, { ...updateDataNote }, { returnDocument: "after" })
        if (!note) {
            return response.notFoundError(res,"note tidak ditemukan")
        }
        noteLogger.info({ event: "note.updated", notebookId: req.params.notebookId, noteId }, "Note updated")
        response.requestSuccessWithData(res, "berhasil update note", { note }, 200)
    } catch (error) {
        noteLogger.error({ event: "note.update.failed", notebookId: req.params.notebookId, noteId: req.params.noteId, err: error }, "Failed to update note")
        response.serverError(res,"gagal update note")
    }
}