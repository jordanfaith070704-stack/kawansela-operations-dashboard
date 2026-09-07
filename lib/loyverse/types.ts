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
  /** Loyverse receipts are identified by receipt_number, not a generic id. */
  id?: string;
  receipt_number?: string;
  store_id: string;
  created_at?: string;
  receipt_date?: string;
  receipt_type?: "SALE" | "REFUND";
  status?: string;
  closed_at?: string;
  cancelled_at?: string | null;
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
