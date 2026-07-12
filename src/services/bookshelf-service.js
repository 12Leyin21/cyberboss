const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { BookshelfStore } = require("../core/bookshelf-store");
const { resolveBodyInput } = require("./text-input");

const VALID_STATUSES = ["reading", "finished", "paused"];
const MAX_TEXT_CHARS = 3_000_000;
const DEFAULT_CHUNK_CHARS = 4_000;
const MAX_CHUNK_CHARS = 8_000;

class BookshelfService {
  constructor({ config }) {
    this.store = new BookshelfStore({ filePath: config.bookshelfFile });
    this.textsDir = config.bookshelfTextsDir;
    this.inboxDir = path.join(config.stateDir, "inbox");
  }

  addBook({ title = "", author = "", addedBy = "", note = "" } = {}) {
    const normalizedTitle = normalizeText(title);
    if (!normalizedTitle) {
      throw new Error("Book title cannot be empty.");
    }
    const book = {
      id: generateId("bk"),
      title: normalizedTitle,
      author: normalizeText(author),
      status: "reading",
      addedBy: normalizeText(addedBy),
      addedAt: new Date().toISOString(),
      progress: {},
      notes: [],
    };
    if (normalizeText(note)) {
      book.notes.push(buildNote({ by: addedBy, text: note }));
    }
    return this.store.insert(book);
  }

  listBooks({ status = "" } = {}) {
    const normalizedStatus = normalizeText(status);
    const books = this.store.list();
    return normalizedStatus ? books.filter((book) => book.status === normalizedStatus) : books;
  }

  getBook({ bookId = "" } = {}) {
    const book = this.store.find(normalizeText(bookId));
    if (!book) {
      throw new Error(`Book not found: ${bookId}`);
    }
    return book;
  }

  updateProgress({ bookId = "", by = "", position = "", note = "" } = {}) {
    const normalizedBy = normalizeText(by);
    const normalizedPosition = normalizeText(position);
    if (!normalizedBy) {
      throw new Error("Progress update requires who is reading (by).");
    }
    if (!normalizedPosition) {
      throw new Error("Progress update requires a position.");
    }
    const now = new Date().toISOString();
    const updated = this.store.update(normalizeText(bookId), (book) => {
      const next = {
        ...book,
        progress: { ...book.progress, [normalizedBy]: { position: normalizedPosition, updatedAt: now } },
      };
      if (normalizeText(note)) {
        next.notes = [...book.notes, buildNote({ by: normalizedBy, text: note, position: normalizedPosition })];
      }
      return next;
    });
    if (!updated) {
      throw new Error(`Book not found: ${bookId}`);
    }
    return updated;
  }

  addNote({ bookId = "", by = "", text = "", position = "" } = {}) {
    const normalizedText = normalizeText(text);
    if (!normalizedText) {
      throw new Error("Note text cannot be empty.");
    }
    const updated = this.store.update(normalizeText(bookId), (book) => ({
      ...book,
      notes: [...book.notes, buildNote({ by, text: normalizedText, position })],
    }));
    if (!updated) {
      throw new Error(`Book not found: ${bookId}`);
    }
    return updated;
  }

  setStatus({ bookId = "", status = "" } = {}) {
    const normalizedStatus = normalizeText(status);
    if (!VALID_STATUSES.includes(normalizedStatus)) {
      throw new Error(`status must be one of ${VALID_STATUSES.join(", ")}.`);
    }
    const updated = this.store.update(normalizeText(bookId), (book) => ({ ...book, status: normalizedStatus }));
    if (!updated) {
      throw new Error(`Book not found: ${bookId}`);
    }
    return updated;
  }

  async setText({ bookId = "", text = "", textFile = "" } = {}) {
    const normalizedBookId = normalizeText(bookId);
    const book = this.store.find(normalizedBookId);
    if (!book) {
      throw new Error(`Book not found: ${bookId}`);
    }

    const resolvedTextFile = textFile ? this.resolveInboxFilePath(textFile) : "";
    const body = await resolveBodyInput({ text, textFile: resolvedTextFile });
    if (!body) {
      throw new Error("Book text cannot be empty. Pass text or textFile.");
    }
    if (body.length > MAX_TEXT_CHARS) {
      throw new Error(`Book text is too long (${body.length} chars, max ${MAX_TEXT_CHARS}). Split it into a shorter excerpt or send it in parts.`);
    }

    fs.mkdirSync(this.textsDir, { recursive: true });
    const filePath = this.buildTextFilePath(normalizedBookId);
    fs.writeFileSync(filePath, body, "utf8");

    const now = new Date().toISOString();
    const updated = this.store.update(normalizedBookId, (current) => ({
      ...current,
      hasText: true,
      textLength: body.length,
      textUpdatedAt: now,
    }));
    return { book: updated, textLength: body.length };
  }

  readText({ bookId = "", offset = 0, length = DEFAULT_CHUNK_CHARS } = {}) {
    const normalizedBookId = normalizeText(bookId);
    const book = this.store.find(normalizedBookId);
    if (!book) {
      throw new Error(`Book not found: ${bookId}`);
    }
    if (!book.hasText) {
      throw new Error(`Book has no stored text yet: ${bookId}. Use cyberboss_bookshelf_set_text first.`);
    }

    const filePath = this.buildTextFilePath(normalizedBookId);
    const fullText = fs.readFileSync(filePath, "utf8");
    const normalizedOffset = Math.max(0, Math.min(Number.parseInt(offset, 10) || 0, fullText.length));
    const normalizedLength = Math.max(1, Math.min(Number.parseInt(length, 10) || DEFAULT_CHUNK_CHARS, MAX_CHUNK_CHARS));
    const slice = fullText.slice(normalizedOffset, normalizedOffset + normalizedLength);
    const nextOffset = normalizedOffset + slice.length;

    return {
      bookId: normalizedBookId,
      title: book.title,
      text: slice,
      offset: normalizedOffset,
      totalLength: fullText.length,
      nextOffset: nextOffset < fullText.length ? nextOffset : null,
      hasMore: nextOffset < fullText.length,
    };
  }

  resolveInboxFilePath(filePath) {
    const resolved = path.resolve(normalizeText(filePath));
    if (!fs.existsSync(resolved)) {
      throw new Error(`Bookshelf inbox file does not exist: ${resolved}`);
    }
    if (!isUnderDirectory(resolved, this.inboxDir)) {
      throw new Error(`Bookshelf text file must be under ${this.inboxDir}`);
    }
    if (!fs.statSync(resolved).isFile()) {
      throw new Error(`Bookshelf text file must be a file: ${resolved}`);
    }
    return resolved;
  }

  buildTextFilePath(bookId) {
    return path.join(this.textsDir, `${bookId}.txt`);
  }
}

function isUnderDirectory(filePath, parentDir) {
  const normalizedParentDir = path.resolve(parentDir);
  const normalizedFilePath = path.resolve(filePath);
  return normalizedFilePath === normalizedParentDir || normalizedFilePath.startsWith(`${normalizedParentDir}${path.sep}`);
}

function buildNote({ by = "", text = "", position = "" } = {}) {
  return {
    id: generateId("note"),
    by: normalizeText(by),
    text: normalizeText(text),
    position: normalizeText(position),
    createdAt: new Date().toISOString(),
  };
}

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { BookshelfService, VALID_STATUSES };
