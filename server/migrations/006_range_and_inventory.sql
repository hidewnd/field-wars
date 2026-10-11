-- 低等级连线射程下限与道具规则升级；历史脚按账号补齐部署人姓名，不改资产数量。
DO $$
DECLARE previous_hash text;
BEGIN
  SELECT rules_hash INTO previous_hash FROM worlds WHERE id=1 FOR UPDATE;
  IF previous_hash IS NULL OR previous_hash='c6ab8b6a8147dad4b39bf948507e3798ef844c892c303d267a6ff5922b823d1c' THEN RETURN; END IF;
  IF previous_hash<>'08d64d0669a96f9154d72814c4fb1e797befcc51b0d6b2a5ee858ae93394bff7' THEN
    RAISE EXCEPTION '规则摘要不匹配，拒绝应用射程与道具交互迁移';
  END IF;
  UPDATE portals p SET state=jsonb_set(jsonb_set(p.state,'{resonators}',(
    SELECT jsonb_agg(CASE WHEN a.id IS NOT NULL AND r.foot->>'ownerName' IS NULL
      THEN r.foot || jsonb_build_object('ownerName',a.state->>'name') ELSE r.foot END ORDER BY r.slot)
    FROM jsonb_array_elements(p.state->'resonators') WITH ORDINALITY AS r(foot,slot)
    LEFT JOIN accounts a ON a.id::text=r.foot->>'owner'
  )),'{version}',to_jsonb((p.state->>'version')::integer+1))
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(p.state->'resonators') r(foot)
    JOIN accounts a ON a.id::text=r.foot->>'owner' WHERE r.foot->>'ownerName' IS NULL);
  UPDATE worlds SET rules_hash='c6ab8b6a8147dad4b39bf948507e3798ef844c892c303d267a6ff5922b823d1c',epoch=epoch+1 WHERE id=1;
END
$$;
