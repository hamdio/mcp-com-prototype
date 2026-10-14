// Replace this tiny example with the problem agreed with your interviewer.
// Start with interfaces, pure logic, and a testable function.
export interface Input {
  values: number[];
}

export function solve(input: Input): number {
  return input.values.reduce((sum, value) => sum + value, 0);
}
