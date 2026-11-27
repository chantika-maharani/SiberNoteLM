import dotenv from "dotenv"

dotenv.config()

const envVariable: {
    PORT: number
    NODE_ENV: string
    LOG_LEVEL: string
    LOG_DIR: string
    LOG_TO_FILE: boolean
    LOG_RETENTION_INFO_DAYS: number
    LOG_RETENTION_ERROR_DAYS: number
    LOG_MAX_FILE_SIZE: string
    MONGO_URL: string
    JWT_KEY: string
    REFRESH_TOKEN_KEY: string
    GEMINI_EMBEDDING_KEY: string
    /** URL publik ke folder uploads, misal: https://yourdomain.com/uploads */
    UPLOAD_BASE_URL: string
    /** Path absolut di server tempat file disimpan, misal: /var/www/sibernote/uploads */
    UPLOADS_DIR: string
    CLOUDINARY_API_SECRET: string
    CLOUDINARY_API_KEY: string
    CLOUDINARY_CLOUD_NAME: string
    GEMINI_MODEL:string
    GEMINI_MODEL_Flashcard: string
} = {
    PORT: Number(process.env.PORT) || 8080,
    NODE_ENV: process.env.NODE_ENV || "development",
    LOG_LEVEL: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
    LOG_DIR: process.env.LOG_DIR || "./logs",
    LOG_TO_FILE: process.env.LOG_TO_FILE
        ? process.env.LOG_TO_FILE === "true"
        : process.env.NODE_ENV === "production",
    LOG_RETENTION_INFO_DAYS: Number(process.env.LOG_RETENTION_INFO_DAYS) || 14,
    LOG_RETENTION_ERROR_DAYS: Number(process.env.LOG_RETENTION_ERROR_DAYS) || 30,
    LOG_MAX_FILE_SIZE: process.env.LOG_MAX_FILE_SIZE || "20m",
    MONGO_URL: process.env.MONGO_URL || "",
    JWT_KEY: process.env.JWT_KEY || "ligma",
    REFRESH_TOKEN_KEY: process.env.REFRESH_TOKEN_KEY || "ligma_refresh",
    GEMINI_EMBEDDING_KEY: process.env.GEMINI_EMBEDDING_KEY || "",
    UPLOAD_BASE_URL: process.env.UPLOAD_BASE_URL || "http://localhost:8080/uploads",
    UPLOADS_DIR: process.env.UPLOADS_DIR || "./uploads",
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME||"",
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY||"",
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET||"",
    GEMINI_MODEL: process.env.GEMINI_MODEL||"",
    GEMINI_MODEL_Flashcard: process.env.GEMINI_MODEL_Flashcard||""
}

export default envVariable
