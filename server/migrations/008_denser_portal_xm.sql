-- 保留当前批次与领取状态，下一次五分钟刷新按新密度生成，避免重复发放。
DO $$
DECLARE previous_hash text;
BEGIN
  SELECT rules_hash INTO previous_hash FROM worlds WHERE id=1 FOR UPDATE;
  IF previous_hash IS NULL OR previous_hash='70a5328bb839a9a88d0a55ad48181f0189c54a5705c7d991f5a473b4d156061b' THEN RETURN; END IF;
  IF previous_hash<>'e8647786cbd54b7405d4175a36a7d43213e3fc189cda3489051843cf92bf37a4' THEN
    RAISE EXCEPTION '规则摘要不匹配，拒绝应用 PO 周边 XM 密度迁移';
  END IF;
  UPDATE worlds SET rules_hash='70a5328bb839a9a88d0a55ad48181f0189c54a5705c7d991f5a473b4d156061b',epoch=epoch+1 WHERE id=1;
END
$$;
