export interface Source {
  id: string;
  name: string;
  base_url?: string;
  doc_count: number;
  last_synced?: string;
  config?: string;
}

export interface Document {
  id: string;
  source_id: string;
  path: string;
  path_depth: number;
  title: string;
  api_path?: string;
  dev_mode?: string;
  doc_type: string;
  content: string;
  content_hash: string;
  prev_content_hash?: string;
  source_url?: string;
  metadata?: string;
  tokenized_title?: string;
  tokenized_content?: string;
  last_updated?: string;
  synced_at: string;
}

export interface ErrorCode {
  id?: number;
  source_id: string;
  code: string;
  message?: string;
  description?: string;
  doc_id?: string;
}

export interface SearchResult {
  id: string;
  source_id: string;
  title: string;
  path: string;
  api_path?: string;
  dev_mode?: string;
  doc_type: string;
  source_url?: string;
  last_updated?: string;
  snippet: string;
  score: number;
}

export interface SearchOptions {
  query: string;
  source?: string;
  mode?: string;
  limit?: number;
}

export interface SyncLog {
  id?: number;
  source_id: string;
  started_at: string;
  finished_at?: string;
  status: 'running' | 'success' | 'failed';
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  error?: string;
}

export interface UpsertDocInput {
  source_id: string;
  path: string;
  title: string;
  content: string;
  api_path?: string;
  dev_mode?: string;
  doc_type?: string;
  source_url?: string;
  metadata?: Record<string, unknown>;
  last_updated?: string;
  tokenized_title?: string;
  tokenized_content?: string;
}

export interface BulkUpsertResult {
  created: number;
  updated: number;
  unchanged: number;
}
