-- Backfill persisted block embeds into the block-reference index. The application
-- now indexes mega-embed nodes on every doc save; this fills older documents.
-- Compare expected occurrences to indexed rows per source/target so a document
-- saved by newer code before migration is not counted twice.
WITH RECURSIVE nodes AS (
  SELECT content.container_id AS source_id, child.node
  FROM mega_content AS content
  JOIN mega_docs AS doc ON doc.id = content.container_id AND doc.deleted_at IS NULL
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(content.body_json -> 'root' -> 'children') = 'array'
      THEN content.body_json -> 'root' -> 'children' ELSE '[]'::jsonb END
  ) AS child(node)
  WHERE content.container_type = 'doc'
  UNION ALL
  SELECT nodes.source_id, child.node
  FROM nodes
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(nodes.node -> 'children') = 'array'
      THEN nodes.node -> 'children' ELSE '[]'::jsonb END
  ) AS child(node)
), block_targets AS (
  SELECT source_id,
    CASE
      WHEN node ->> 'type' = 'mega-embed'
        THEN (node -> 'embed' ->> 'targetDocId') || ':' || (node -> 'embed' ->> 'targetBlockId')
      ELSE (node -> 'blockRef' ->> 'targetDocId') || ':' || (node -> 'blockRef' ->> 'targetBlockId')
    END AS target_id
  FROM nodes
  WHERE (
    node ->> 'type' = 'mega-embed'
    AND nullif(node -> 'embed' ->> 'targetDocId', '') IS NOT NULL
    AND nullif(node -> 'embed' ->> 'targetBlockId', '') IS NOT NULL
  ) OR (
    node ->> 'type' = 'mega-block-ref'
    AND nullif(node -> 'blockRef' ->> 'targetDocId', '') IS NOT NULL
    AND nullif(node -> 'blockRef' ->> 'targetBlockId', '') IS NOT NULL
    AND coalesce(node -> 'blockRef' ->> 'status', 'ok') = 'ok'
  )
), expected AS (
  SELECT source_id, target_id, count(*)::integer AS expected_count
  FROM block_targets
  GROUP BY source_id, target_id
), indexed AS (
  SELECT source_id, target_id, count(*)::integer AS indexed_count
  FROM mega_content_links
  WHERE source_type = 'doc' AND target_kind = 'block'
  GROUP BY source_id, target_id
)
INSERT INTO mega_content_links (id, source_type, source_id, target_kind, target_id, context_summary)
SELECT 'lnk_embed_backfill_' || md5(expected.source_id || ':' || expected.target_id || ':' || missing.n::text),
  'doc', expected.source_id, 'block', expected.target_id, NULL
FROM expected
LEFT JOIN indexed ON indexed.source_id = expected.source_id AND indexed.target_id = expected.target_id
CROSS JOIN LATERAL generate_series(
  1, greatest(expected.expected_count - coalesce(indexed.indexed_count, 0), 0)
) AS missing(n)
ON CONFLICT (id) DO NOTHING;
