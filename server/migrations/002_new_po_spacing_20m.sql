-- 2026-10-11 用户确认：新增 PO 与已批准 PO 的最小间距由 150 米改为 20 米。
-- 只接受已知旧规则，保留全部世界/账号数据；代次递增阻止旧参数进程继续写入。
DO $$
DECLARE
  previous_hash text;
BEGIN
  SELECT rules_hash INTO previous_hash FROM worlds WHERE id = 1 FOR UPDATE;
  IF previous_hash IS NULL THEN
    RETURN;
  END IF;
  IF previous_hash = '52ff47dbebbb352e7c8786c4a56b35ca9a18b9d97f56ba7acb6e819c64536d28' THEN
    UPDATE worlds
       SET rules_hash = '8b7a995ee5ba28076fb7b7464729836c9e4efde1b2e2d703e26e23f8e0bfaa64',
           epoch = epoch + 1
     WHERE id = 1;
  ELSIF previous_hash <> '8b7a995ee5ba28076fb7b7464729836c9e4efde1b2e2d703e26e23f8e0bfaa64' THEN
    RAISE EXCEPTION '规则摘要不匹配，拒绝应用新增 PO 20 米间距迁移';
  END IF;
END
$$;
