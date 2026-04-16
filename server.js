const multer = require("multer");
const pdf = require("pdf-parse");
const mammoth = require("mammoth");

// Store files in memory (no disk writes)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "text/plain",
      "text/csv",
    ];
    const extAllowed = [".pdf", ".docx", ".doc", ".txt", ".csv"];
    const ext = "." + file.originalname.split(".").pop().toLowerCase();

    if (allowed.includes(file.mimetype) || extAllowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type. Upload PDF, Word (.docx), or text files."));
    }
  },
});

async function extractText(file) {
  const ext = file.originalname.split(".").pop().toLowerCase();

  if (ext === "pdf") {
    const data = await pdf(file.buffer);
    return data.text || "";
  }

  if (ext === "docx" || ext === "doc") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value || "";
  }

  if (ext === "txt" || ext === "csv") {
    return file.buffer.toString("utf-8");
  }

  return file.buffer.toString("utf-8");
}

/**
 * Split text into chunks of ~800 characters with 100-char overlap
 * so long documents are searchable and no chunk exceeds embedding limits.
 */
function chunkText(text, chunkSize = 800, overlap = 100) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];

  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);

    // Try to break at a paragraph or sentence boundary
    if (end < normalized.length) {
      const paraBreak = normalized.lastIndexOf("\n\n", end);
      const sentBreak = normalized.lastIndexOf(". ", end);

      if (paraBreak > start + chunkSize / 2) {
        end = paraBreak + 2;
      } else if (sentBreak > start + chunkSize / 2) {
        end = sentBreak + 2;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);

    start = end - overlap;
    if (start >= normalized.length) break;
  }

  return chunks;
}

module.exports = { upload, extractText, chunkText };
