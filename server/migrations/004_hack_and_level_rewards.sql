-- Hack 高阶掉落与逐级礼包：仅迁移已知旧规则，不追溯补发历史等级礼包。
-- 礼包由升级动作和原收据共同持久化；战报字段由后续动作按需写入。
DO $$
DECLARE previous_hash text;
BEGIN
  SELECT rules_hash INTO previous_hash FROM worlds WHERE id=1 FOR UPDATE;
  IF previous_hash IS NULL OR previous_hash='854452ad6a4eeae20c1d5a64864da9a5891d3a920920cc0c576e965b20b97166' THEN
    RETURN;
  END IF;
  IF previous_hash<>'0ffdd0e607b88611db790b45531c53337b1b431205ab81c827a0a84f182f6e1f' THEN
    RAISE EXCEPTION '规则摘要不匹配，拒绝应用掉落与升级礼包迁移';
  END IF;
  UPDATE worlds SET rules_hash='854452ad6a4eeae20c1d5a64864da9a5891d3a920920cc0c576e965b20b97166',epoch=epoch+1 WHERE id=1;
END
$$;
