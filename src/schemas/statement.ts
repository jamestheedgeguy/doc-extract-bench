/** Canonical normalized bank-statement shape.
 *  Statements are scored by the Bankstatemently evaluation API (their ground
 *  truth is server-side); this shape is what we submit to it. */

export interface StatementTransaction {
  date: string | null; // ISO YYYY-MM-DD
  description: string | null;
  /** Signed amount: negative = money out (debit), positive = money in (credit). */
  amount: number | null;
  balance: number | null;
}

export interface CanonicalStatement {
  institution: string | null;
  accountHolder: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  transactions: StatementTransaction[];
}
