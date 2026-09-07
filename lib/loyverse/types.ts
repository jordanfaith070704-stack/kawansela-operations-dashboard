export type LoyversePayment = {
  payment_type_id?: string;
  name?: string;
  amount: number;
};

export type LoyverseReceiptLine = {
  /** Loyverse may provide an immutable line id. Prefer it over the array index. */
  id?: string;
  line_item_id?: string;
  item_id: string;
  quantity: number;
  total_money?: number;
};

export type LoyverseReceipt = {
  id: string;
  store_id: string;
  created_at?: string;
  receipt_type?: "SALE" | "REFUND";
  status?: string;
  closed_at: string;
  employee_id?: string;
  payments?: LoyversePayment[];
  line_items: LoyverseReceiptLine[];
};

export type SyncResult = {
  processed: number;
  duplicated: number;
  pending: number;
  warnings: string[];
  syncRunId?: string;
};
