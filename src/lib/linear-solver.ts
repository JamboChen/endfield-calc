/**
 * Solves a system of linear equations Ax = B using Gaussian elimination
 * @param matrix The coefficient matrix A (array of rows)
 * @param constants The constant vector B
 * @returns The solution vector x, or null if singular/no solution
 */
export function solveLinearSystem(
  matrix: number[][],
  constants: number[],
): number[] | null {
  const n = matrix.length;
  // Deep copy to avoid modifying inputs
  const A = matrix.map((row) => [...row]);
  const B = [...constants];

  // Gaussian elimination with partial pivoting
  for (let i = 0; i < n; i++) {
    // Find pivot
    let maxEl = Math.abs(A[i][i]);
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > maxEl) {
        maxEl = Math.abs(A[k][i]);
        maxRow = k;
      }
    }

    // Swap maximum row with current row (column by column)
    for (let k = i; k < n; k++) {
      const tmp = A[maxRow][k];
      A[maxRow][k] = A[i][k];
      A[i][k] = tmp;
    }
    const tmp = B[maxRow];
    B[maxRow] = B[i];
    B[i] = tmp;

    // Make all rows below this one 0 in current column
    if (Math.abs(A[i][i]) < 1e-9) {
      return null; // Singular matrix
    }

    for (let k = i + 1; k < n; k++) {
      const c = -A[k][i] / A[i][i];
      for (let j = i; j < n; j++) {
        if (i === j) {
          A[k][j] = 0;
        } else {
          A[k][j] += c * A[i][j];
        }
      }
      B[k] += c * B[i];
    }
  }

  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = 0;
    for (let j = i + 1; j < n; j++) {
      sum += A[i][j] * x[j];
    }
    x[i] = (B[i] - sum) / A[i][i];
  }

  return x;
}

/**
 * Solve an over/exactly-determined linear system.
 * - `numVars === 0` → returns `[]` (no unknowns).
 * - `rows.length > numVars` (overdetermined):
 *   - `numVars === 1`: return `[max(b/a)]` across rows with non-zero coefficient,
 *     matching the Phase 4 deficit-propagation semantics (satisfy tightest constraint).
 *   - Otherwise pick the `numVars` rows with largest |RHS| and solve that square system.
 * - `rows.length <= numVars`: solve directly via `solveLinearSystem`.
 * Returns `null` on singular systems.
 */
export function solveOverdetermined(
  matrix: number[][],
  constants: number[],
  numVars: number,
): number[] | null {
  if (numVars === 0) return [];
  const rowCount = matrix.length;

  if (rowCount > numVars) {
    if (numVars === 1) {
      let maxR = 0;
      for (let i = 0; i < rowCount; i++) {
        const a = matrix[i][0];
        const b = constants[i];
        if (Math.abs(a) > 1e-9) {
          const r = b / a;
          if (r > maxR) maxR = r;
        }
      }
      return [maxR];
    }
    const indices = Array.from({ length: rowCount }, (_, i) => i);
    indices.sort((a, b) => Math.abs(constants[b]) - Math.abs(constants[a]));
    const topIndices = indices.slice(0, numVars);
    const subMatrix = topIndices.map((i) => matrix[i]);
    const subConstants = topIndices.map((i) => constants[i]);
    return solveLinearSystem(subMatrix, subConstants);
  }

  return solveLinearSystem(matrix, constants);
}
