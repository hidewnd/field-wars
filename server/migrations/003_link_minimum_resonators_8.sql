-- 满八脚才保持连线：升级旧世界时拆除任一端不足八脚的既有线及依赖场。
-- 有实际删除才推进提交序号并写墓碑事件；账号/AP、其他世界资产及检查点不变。
DO $$
DECLARE
  previous_hash text;
  previous_state jsonb;
  previous_seq bigint;
  retained_links jsonb;
  removed_links jsonb;
  retained_fields jsonb;
  removed_fields jsonb;
  next_state jsonb;
  next_seq bigint;
BEGIN
  SELECT rules_hash,state,seq INTO previous_hash,previous_state,previous_seq FROM worlds WHERE id=1 FOR UPDATE;
  IF previous_hash IS NULL OR previous_hash='0ffdd0e607b88611db790b45531c53337b1b431205ab81c827a0a84f182f6e1f' THEN
    RETURN;
  END IF;
  IF previous_hash<>'8b7a995ee5ba28076fb7b7464729836c9e4efde1b2e2d703e26e23f8e0bfaa64' THEN
    RAISE EXCEPTION '规则摘要不匹配，拒绝应用满八脚连线迁移';
  END IF;

  WITH eligible AS (
    SELECT p.id FROM portals p
    WHERE (SELECT count(*) FROM jsonb_array_elements(p.state->'resonators') AS r(value)
           WHERE r.value<>'null'::jsonb)=8
  ), inspected AS (
    SELECT l.value,l.ordinality,origin.id IS NOT NULL AND destination.id IS NOT NULL AS valid
    FROM jsonb_array_elements(previous_state->'links') WITH ORDINALITY AS l(value,ordinality)
    LEFT JOIN eligible origin ON origin.id=l.value->>'origin'
    LEFT JOIN eligible destination ON destination.id=l.value->>'destination'
  )
  SELECT coalesce(jsonb_agg(value ORDER BY ordinality) FILTER (WHERE valid),'[]'::jsonb),
         coalesce(jsonb_agg(value->>'id' ORDER BY ordinality) FILTER (WHERE NOT valid),'[]'::jsonb)
    INTO retained_links,removed_links FROM inspected;

  WITH inspected AS (
    SELECT f.value,f.ordinality,
      NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(f.value->'links') AS edge(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(retained_links) AS link(value)
          WHERE link.value->>'id'=edge.id
        )
      ) AS valid
    FROM jsonb_array_elements(previous_state->'fields') WITH ORDINALITY AS f(value,ordinality)
  )
  SELECT coalesce(jsonb_agg(value ORDER BY ordinality) FILTER (WHERE valid),'[]'::jsonb),
         coalesce(jsonb_agg(value->>'id' ORDER BY ordinality) FILTER (WHERE NOT valid),'[]'::jsonb)
    INTO retained_fields,removed_fields FROM inspected;

  IF jsonb_array_length(removed_links)>0 OR jsonb_array_length(removed_fields)>0 THEN
    next_seq:=previous_seq+1;
    next_state:=jsonb_set(jsonb_set(jsonb_set(previous_state,'{links}',retained_links),
      '{fields}',retained_fields),'{seq}',to_jsonb(next_seq::text));
    UPDATE worlds SET rules_hash='0ffdd0e607b88611db790b45531c53337b1b431205ab81c827a0a84f182f6e1f',
      epoch=epoch+1,seq=next_seq,state=next_state WHERE id=1;
    INSERT INTO outbox(seq,event,created_at) VALUES(next_seq,
      jsonb_build_object('type','invalidate','committedSeq',next_seq::text,
        'deleted',jsonb_build_object('links',removed_links,'fields',removed_fields,
          'resonators','[]'::jsonb,'mods','[]'::jsonb),'privateAlerts','[]'::jsonb),
      (extract(epoch FROM clock_timestamp())*1000)::bigint);
  ELSE
    UPDATE worlds SET rules_hash='0ffdd0e607b88611db790b45531c53337b1b431205ab81c827a0a84f182f6e1f',
      epoch=epoch+1 WHERE id=1;
  END IF;
END
$$;
