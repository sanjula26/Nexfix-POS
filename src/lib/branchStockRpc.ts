export type BranchStockAdjustmentRpcInput = {
  shopId: string;
  deviceId: string;
  productId: string;
  delta: number;
  note: string;
  adjustmentId: string;
  expectedBranchQty?: number;
};

/** Keep the legacy delta RPC and editor compare-and-set RPC argument contracts explicit. */
export function buildBranchStockAdjustmentRpcRequest(
  input: BranchStockAdjustmentRpcInput,
  resolvedBranchId: string,
): { rpcName: string; rpcArgs: Record<string, unknown> } {
  const rpcName = input.expectedBranchQty === undefined
    ? 'adjust_branch_stock_atomic'
    : 'adjust_branch_stock_atomic_expected';
  const rpcArgs: Record<string, unknown> = {
    p_shop_id: input.shopId,
    p_branch_id: resolvedBranchId,
    p_device_id: input.deviceId,
    p_product_id: input.productId,
    p_delta: input.delta,
    p_note: input.note,
    p_adjustment_id: input.adjustmentId,
  };
  if (input.expectedBranchQty !== undefined) rpcArgs.p_expected_branch_qty = input.expectedBranchQty;
  return { rpcName, rpcArgs };
}
