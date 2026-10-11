-- 现有脚的下一次衰减最迟在升级后六小时发生，已到期或更早到期的时刻保留。
-- 不追溯改写历史计分；之后继续按新的六小时周期推进。
DO $$
DECLARE
  previous_hash text;
  deadline bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 21600000;
BEGIN
  SELECT rules_hash INTO previous_hash FROM worlds WHERE id=1 FOR UPDATE;
  IF previous_hash IS NULL OR previous_hash='e8647786cbd54b7405d4175a36a7d43213e3fc189cda3489051843cf92bf37a4' THEN RETURN; END IF;
  IF previous_hash<>'c6ab8b6a8147dad4b39bf948507e3798ef844c892c303d267a6ff5922b823d1c' THEN
    RAISE EXCEPTION '规则摘要不匹配，拒绝应用地面 XM 与六小时衰减迁移';
  END IF;
  UPDATE portals p SET state=jsonb_set(jsonb_set(p.state,'{resonators}',(
    SELECT jsonb_agg(CASE WHEN r.foot<>'null'::jsonb
      THEN jsonb_set(r.foot,'{nextDecayAt}',to_jsonb(LEAST((r.foot->>'nextDecayAt')::bigint,deadline)))
      ELSE r.foot END ORDER BY r.slot)
    FROM jsonb_array_elements(p.state->'resonators') WITH ORDINALITY AS r(foot,slot)
  )),'{version}',to_jsonb((p.state->>'version')::integer+1))
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(p.state->'resonators') r(foot)
    WHERE (r.foot->>'nextDecayAt')::bigint>deadline);
  UPDATE worlds SET rules_hash='e8647786cbd54b7405d4175a36a7d43213e3fc189cda3489051843cf92bf37a4',epoch=epoch+1 WHERE id=1;
END
$$;
