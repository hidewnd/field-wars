-- 操作距离统一为30米，新PO最小间距为5米；只更新规则摘要和执行器代次，不重排已有脚或玩家位置。
DO $$
DECLARE previous_hash text;
BEGIN
  SELECT rules_hash INTO previous_hash FROM worlds WHERE id=1 FOR UPDATE;
  IF previous_hash IS NULL OR previous_hash='08d64d0669a96f9154d72814c4fb1e797befcc51b0d6b2a5ee858ae93394bff7' THEN
    RETURN;
  END IF;
  IF previous_hash<>'854452ad6a4eeae20c1d5a64864da9a5891d3a920920cc0c576e965b20b97166' THEN
    RAISE EXCEPTION '规则摘要不匹配，拒绝应用30米操作距离与5米PO间距迁移';
  END IF;
  UPDATE worlds SET rules_hash='08d64d0669a96f9154d72814c4fb1e797befcc51b0d6b2a5ee858ae93394bff7',epoch=epoch+1 WHERE id=1;
END
$$;
