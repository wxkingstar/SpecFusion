-- SpecFusion Database Schema
-- SQLite / Cloudflare D1

-- 文档源
CREATE TABLE IF NOT EXISTS sources (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    base_url    TEXT,
    doc_count   INTEGER DEFAULT 0,
    last_synced TEXT,
    config      TEXT
);

-- 文档（Markdown 全文直接存 content 列）
CREATE TABLE IF NOT EXISTS documents (
    id                TEXT PRIMARY KEY,
    source_id         TEXT NOT NULL,
    path              TEXT NOT NULL,
    path_depth        INTEGER NOT NULL DEFAULT 1,
    title             TEXT NOT NULL,
    api_path          TEXT,
    dev_mode          TEXT,
    doc_type          TEXT DEFAULT 'api_reference',
    content           TEXT NOT NULL,
    content_hash      TEXT NOT NULL,
    prev_content_hash TEXT,
    source_url        TEXT,
    metadata          TEXT,
    tokenized_title   TEXT,
    tokenized_content TEXT,
    last_updated      TEXT,
    synced_at         TEXT NOT NULL,
    UNIQUE(source_id, path)
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(last_updated);
CREATE INDEX IF NOT EXISTS idx_documents_api_path ON documents(api_path);
CREATE INDEX IF NOT EXISTS idx_documents_dev_mode ON documents(source_id, dev_mode);
CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);

-- 错误码映射表
CREATE TABLE IF NOT EXISTS error_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   TEXT NOT NULL,
    code        TEXT NOT NULL,
    message     TEXT,
    description TEXT,
    doc_id      TEXT,
    UNIQUE(source_id, code)
);

CREATE INDEX IF NOT EXISTS idx_error_codes_code ON error_codes(code);

-- FTS5 全文检索（使用 jieba 预分词后的内容）
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    title,
    content,
    content='documents',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

-- FTS5 同步触发器
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, content)
    VALUES (new.rowid, new.tokenized_title, new.tokenized_content);
END;

CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.tokenized_title, old.tokenized_content);
END;

CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.tokenized_title, old.tokenized_content);
    INSERT INTO documents_fts(rowid, title, content)
    VALUES (new.rowid, new.tokenized_title, new.tokenized_content);
END;

-- 同步日志
CREATE TABLE IF NOT EXISTS sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL,
    created     INTEGER DEFAULT 0,
    updated     INTEGER DEFAULT 0,
    unchanged   INTEGER DEFAULT 0,
    deleted     INTEGER DEFAULT 0,
    error       TEXT
);

-- 搜索日志
CREATE TABLE IF NOT EXISTS search_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    query        TEXT NOT NULL,
    source       TEXT,
    result_count INTEGER NOT NULL,
    top_score    REAL,
    took_ms      INTEGER,
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_log_created ON search_log(created_at);
