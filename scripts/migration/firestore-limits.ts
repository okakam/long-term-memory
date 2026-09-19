export const FIRESTORE_DOCUMENT_LIMIT_BYTES = 1_048_576;
export const FIRESTORE_REQUEST_LIMIT_BYTES = 10 * 1_048_576;
export const FIRESTORE_MAX_WRITES_PER_TRANSACTION = 500;

// JSONの概算とFirestoreのwire formatとの差を吸収するため、公式上限より余裕を持たせる。
export const MIGRATION_DOCUMENT_BUDGET_BYTES = 900_000;
export const MIGRATION_REQUEST_BUDGET_BYTES = 9_000_000;

export interface FirestoreWriteEstimate {
  path: string;
  data?: unknown;
}

function estimateBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

export function assertFirestoreDocumentBudget(label: string, path: string, data: unknown): void {
  const bytes = estimateBytes(data) + Buffer.byteLength(path, 'utf8');
  if (bytes > MIGRATION_DOCUMENT_BUDGET_BYTES) {
    throw new Error(`Firestore document budget exceeded: ${label} (${bytes} bytes)`);
  }
}

export function assertFirestoreTransactionBudget(label: string, writes: FirestoreWriteEstimate[]): void {
  if (writes.length > FIRESTORE_MAX_WRITES_PER_TRANSACTION) {
    throw new Error(`Firestore transaction write count exceeded: ${label} (${writes.length} writes)`);
  }
  const bytes = writes.reduce((total, write) => total + estimateBytes(write.data) + Buffer.byteLength(write.path, 'utf8'), 0);
  if (bytes > MIGRATION_REQUEST_BUDGET_BYTES) {
    throw new Error(`Firestore transaction budget exceeded: ${label} (${bytes} bytes)`);
  }
}
