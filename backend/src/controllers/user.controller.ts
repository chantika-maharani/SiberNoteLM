import fs from "fs"
import path from "path"
import { type Request, type Response } from "express"
import bcrypt from "bcrypt"
import jwt from "jsonwebtoken"
import User from "../models/user.model.js"
import RefreshToken from "../models/refreshToken.model.js"
import envVariable from "../utils/ENV.js"
import response from "../utils/response.js"
import { createModuleLogger } from "../config/logger.js"

const authLogger = createModuleLogger("auth")

/** Masa berlaku refresh token (hari). */
const REFRESH_TOKEN_EXPIRES_DAYS = 7

/** Hash password dengan bcrypt (salt rounds = 10). */
const hashPassword = async (plain: string) => bcrypt.hash(plain, 10)

/** Bandingkan plain password dengan hash tersimpan. */
const verifyPassword = async (plain: string, hashed: string) => bcrypt.compare(plain, hashed)

/** Buat JWT access token (expire 1 jam). Payload: `{ userId }`. */
const signAccessToken = (userId: string) =>
    jwt.sign({ userId }, envVariable.JWT_KEY, { expiresIn: "1h" })

/** Buat JWT refresh token (expire sesuai `REFRESH_TOKEN_EXPIRES_DAYS`). Payload: `{ userId }`. */
const signRefreshToken = (userId: string) =>
    jwt.sign({ userId }, envVariable.REFRESH_TOKEN_KEY, { expiresIn: `${REFRESH_TOKEN_EXPIRES_DAYS}d` })

/**
 * Simpan refresh token ke DB beserta tanggal kadaluarsa.
 * Dipakai saat register/login agar token bisa di-revoke saat logout.
 */
const saveRefreshToken = async (userId: string, token: string) => {
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRES_DAYS)
    await RefreshToken.create({ userId, token, expiresAt })
}

/**
 * Register user baru.
 *
 * Body: `{ email, password, username }`
 * - Gagal 409 jika email atau username sudah terdaftar.
 * - Sukses 201 mengembalikan `accessToken` + `refreshToken`.
 */
export const registerUser = async (req: Request, res: Response) => {
    try {
        const { email, password, username } = req.body

        const existingUser = await User.findOne({ $or: [{ email }, { username }] })
        if (existingUser) {
            const field = existingUser.email === email.toLowerCase() ? "email" : "username"
            authLogger.warn(
                { event: "auth.register.failed", reason: `${field}_already_exists` },
                "User registration rejected: duplicate field",
            )
            return response.userError(res, `${field} sudah terdaftar`, 409)
        }

        const hashedPassword = await hashPassword(password)
        const user = await User.create({ email, username, password: hashedPassword })

        const accessToken = signAccessToken(user._id.toString())
        const refreshToken = signRefreshToken(user._id.toString())
        await saveRefreshToken(user._id.toString(), refreshToken)
        authLogger.info(
            { event: "auth.register.success", userId: user._id.toString() },
            "User registered successfully",
        )
        return response.requestSuccessWithData(res, "berhasil buat user", { accessToken, refreshToken }, 201)
    } catch (error) {
        authLogger.error(
            { event: "auth.register.failed", reason: "internal_error", err: error },
            "User registration failed",
        )
        return response.serverError(res, "gagal register user")
    }
}

/**
 * Login user.
 *
 * Body: `{ email, password }`
 * - Gagal jika email tidak ketemu atau password tidak cocok.
 * - Sukses 200 mengembalikan pasangan token baru (refresh token juga disimpan ke DB).
 */
export const loginUser = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body
        const user = await User.findOne({ email: email })
        if (!user || !(await verifyPassword(password, user.password))) {
            authLogger.warn(
                {
                    event: "auth.login.failed",
                    ...(user ? { userId: user._id.toString() } : {}),
                    reason: "invalid_credentials",
                },
                "User login failed",
            )
            return response.userError(res, "email atau password salah")
        }

        const accessToken = signAccessToken(user._id.toString())
        const refreshToken = signRefreshToken(user._id.toString())
        await saveRefreshToken(user._id.toString(), refreshToken)
        authLogger.info(
            { event: "auth.login.success", userId: user._id.toString() },
            "User logged in successfully",
        )
        return response.requestSuccessWithData(res, "berhasil login", { accessToken, refreshToken }, 200)
    } catch (error) {
        authLogger.error(
            { event: "auth.login.failed", reason: "internal_error", err: error },
            "User login error",
        )
        return response.serverError(res, "gagal login user")
    }
}

/**
 * Perbarui access token memakai refresh token yang masih valid.
 *
 * Body: `{ refreshToken }`
 * - Token harus ada di DB dan lolos `jwt.verify`.
 * - Jika JWT invalid/expired, entry di DB dihapus lalu return error.
 * - Sukses mengembalikan `accessToken` baru (refresh token tidak diganti).
 */
export const refreshAccessToken = async (req: Request, res: Response) => {
    try {
        const { refreshToken } = req.body

        if (!refreshToken) {
            authLogger.warn(
                { event: "auth.refresh.failed", reason: "missing_refresh_token" },
                "Token refresh failed",
            )
            return response.userError(res, "refresh token tidak ada")
        }

        // Pastikan token masih tercatat di DB (bisa di-revoke via logout)
        const stored = await RefreshToken.findOne({ token: refreshToken })
        if (!stored) {
            authLogger.warn(
                { event: "auth.refresh.failed", reason: "refresh_token_not_found" },
                "Token refresh failed",
            )
            return response.userError(res, "refresh token tidak valid atau sudah expired")
        }

        let payload: { userId: string }
        try {
            payload = jwt.verify(refreshToken, envVariable.REFRESH_TOKEN_KEY) as { userId: string }
        } catch {
            await stored.deleteOne()
            authLogger.warn(
                {
                    event: "auth.refresh.failed",
                    userId: stored.userId.toString(),
                    reason: "invalid_or_expired_refresh_token",
                },
                "Token refresh failed",
            )
            return response.userError(res, "refresh token tidak valid atau sudah expired")
        }

        const accessToken = signAccessToken(payload.userId)
        authLogger.info(
            { event: "auth.refresh.success", userId: payload.userId },
            "Access token refreshed",
        )

        return response.requestSuccessWithData(res, "access token berhasil diperbarui", { accessToken }, 200)
    } catch (error) {
        authLogger.error(
            { event: "auth.refresh.failed", reason: "internal_error", err: error },
            "Token refresh error",
        )
        return response.serverError(res, "gagal refresh token")
    }
}

/**
 * Logout — mencabut refresh token dari DB.
 *
 * Body: `{ refreshToken }`
 * Access token tidak di-blacklist; client wajib membuangnya sendiri.
 */
export const logoutUser = async (req: Request, res: Response) => {
    try {
        const { refreshToken } = req.body

        if (!refreshToken) {
            return response.userError(res, "refresh token tidak ada")
        }

        const deleted = await RefreshToken.findOneAndDelete({ token: refreshToken }).select("userId")
        authLogger.info(
            {
                event: "auth.logout",
                ...(deleted?.userId ? { userId: deleted.userId.toString() } : {}),
            },
            "User logged out",
        )
        return response.requestSuccessWithData(res, "berhasil logout", {}, 200)
    } catch (error) {
        authLogger.error(
            { event: "auth.logout.failed", err: error },
            "User logout failed",
        )
        return response.serverError(res, "gagal logout")
    }
}

/**
 * Ambil profil user yang sedang login.
 *
 * Membutuhkan `authenticate` middleware (`req.userId`).
 * Password tidak ikut dikembalikan (`.select("-password")`).
 */
export const getUser = async (req: Request, res: Response) => {
    try {
        const userId = req.userId

        if (!userId) {
            return response.userError(res, "tidak terautentikasi")
        }

        const user = await User.findById(userId).select("-password")
        if (!user) {
            return response.notFoundError(res, "user tidak ketemu")
        }
        authLogger.debug({ event: "user.profile.fetched", userId }, "Fetched user profile")
        return response.requestSuccessWithData(res, "berhasil get data user", { user }, 200)
    } catch (error) {
        authLogger.error(
            { event: "user.profile.fetch_failed", userId: req.userId, err: error },
            "Failed to fetch user profile",
        )
        return response.serverError(res, "gagal get data user")
    }
}

/**
 * Update username dan/atau avatar user yang sedang login.
 *
 * Membutuhkan `authenticate` + `handleAvatarUpload`.
 * Body (multipart): `username` (opsional) dan/atau file field `avatar` (opsional).
 * Minimal salah satu harus diisi.
 *
 * Avatar disimpan oleh multer diskStorage ke `UPLOADS_DIR/avatars/{userId}/avatar.jpg`
 * (lihat `upload.middleware.ts`). File lama tertimpa karena nama tetap `avatar.jpg`.
 * Controller hanya membangun URL publik: `{UPLOAD_BASE_URL}/avatars/{userId}/avatar.jpg`.
 */
export const updateUsernameOravatarUser = async (req: Request, res: Response) => {
    try {
        const userId = req.userId
        const { username } = req.body
        const avatarFile = req.file

        if (!userId) {
            return response.userError(res, "tidak terautentikasi")
        }

        if (!username && !avatarFile) {
            return response.userError(res, "minimal username atau avatar harus diisi", 400)
        }

        const updateData: { username?: string; avatarUrl?: string } = {}

        if (username) {
            const isUsernameExist = await User.findOne({ username })
            if (isUsernameExist) {
                return response.userError(res, "username sudah terdaftar", 400)
            }
            updateData.username = username
        }

        if (avatarFile) {
            const base = envVariable.UPLOAD_BASE_URL.replace(/\/$/, "")
            updateData.avatarUrl = `${base}/avatars/${userId}/avatar.jpg`
        }

        const user = await User.findByIdAndUpdate(userId, updateData, { returnDocument: "after" }).select("-password")
        authLogger.info(
            {
                event: "user.profile.updated",
                userId,
                updatedUsername: Boolean(username),
                updatedAvatar: Boolean(avatarFile),
            },
            "User profile updated",
        )
        return response.requestSuccessWithData(res, "Profil berhasil diperbarui", { user }, 200)
    } catch (error) {
        authLogger.error(
            { event: "user.profile.update_failed", userId: req.userId, err: error },
            "Failed to update user profile",
        )
        return response.serverError(res, "gagal update data user")
    }
}

/**
 * Ganti password user yang sedang login.
 *
 * Body: `{ oldPassword, newPassword }`
 * - Verifikasi password lama dulu.
 * - `newPassword` tidak boleh sama dengan username.
 * - Password baru di-hash sebelum disimpan.
 */
export const updateUserPassword = async (req: Request, res: Response) => {
    try {

        const { newPassword, oldPassword } = req.body
        const userId = req.userId

        if (!userId) {
            return response.userError(res, "tidak terautentikasi")

        }
        const user = await User.findById(userId)
        if (!user) {
            return response.notFoundError(res, "user tidak ditemukan")
        }
        if (user.username === newPassword) {
            return response.notFoundError(res, "password tidak boleh sama dengan username")
        }
        const isOldPasswordMatch = await verifyPassword(oldPassword, user.password)
        if (!isOldPasswordMatch) {
            authLogger.warn(
                { event: "user.password.update_failed", userId, reason: "old_password_mismatch" },
                "Password update failed: old password mismatch",
            )
            return response.userError(res, "Password lama salah", 400)
        }
        const hashedNewPassword = await hashPassword(newPassword)
        await User.findByIdAndUpdate(userId, { password: hashedNewPassword })
        authLogger.info({ event: "user.password.updated", userId }, "User password updated")
        return response.requestSuccess(res, "Password berhasil diperbarui")
    }
    catch (error) {
        authLogger.error(
            { event: "user.password.update_failed", userId: req.userId, err: error },
            "Failed to update user password",
        )
        return response.serverError(res, "gagal update password user")
    }
}
