const fs = require("fs");
const path = require("path");

class BookshelfStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { books: [] };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const books = Array.isArray(parsed?.books) ? parsed.books : [];
      this.state = { books: books.filter(Boolean) };
    } catch {
      this.state = { books: [] };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  list() {
    this.load();
    return this.state.books;
  }

  find(bookId) {
    this.load();
    return this.state.books.find((book) => book.id === bookId) || null;
  }

  insert(book) {
    this.load();
    this.state.books.push(book);
    this.save();
    return book;
  }

  update(bookId, mutator) {
    this.load();
    const index = this.state.books.findIndex((book) => book.id === bookId);
    if (index === -1) {
      return null;
    }
    const updated = mutator(this.state.books[index]);
    this.state.books[index] = updated;
    this.save();
    return updated;
  }
}

module.exports = { BookshelfStore };
