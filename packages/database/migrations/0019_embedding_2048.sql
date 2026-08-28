-- 嵌入模型从 nvidia/nv-embed-v1（4096 维，已于 2026-08-25 EOL）切换为
-- nvidia/nemotron-3-embed-1b（2048 维）。旧向量维度放不进新列，且模型已变，
-- 旧向量毫无用处：先清空 embedding 与 content_hash（content_hash 清空是为了让
-- index-worker 把全部文档视为已变化而全量重建索引），再 ALTER 列类型。
UPDATE "issue_documents" SET "embedding" = NULL, "content_hash" = NULL;
ALTER TABLE "issue_documents" ALTER COLUMN "embedding" TYPE vector(2048);
